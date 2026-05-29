/**
 * src/routes/reports.js
 *
 * P/OD logic (location-based, per employee assignment):
 *   - Employee has NO assigned_block/assigned_district → always P (default)
 *   - Employee HAS assignment:
 *       check-in location matches assigned_block or assigned_district → P
 *       check-in location is in ANY Tripura block/district (but not assigned) → OD
 *       check-in location is outside ALL known blocks/districts → '' (blank)
 *
 * Cell codes:
 *   P   = Present at assigned location       → no colour
 *   OD  = On Duty at other Tripura location  → no colour
 *   L   = Leave (approved) OR rejected leave with no re-check-in → RED
 *   A   = Absent (no check-in, after join)   → RED
 *   WO  = Weekend                            → light blue
 *   ""  = Blank (future / pre-join / outside all known locations / leave pending)
 *
 * Leave status logic:
 *   leave_status === 'Pending'  → blank  (not yet decided)
 *   leave_status === 'Approved' → L
 *   leave_status === 'Rejected' + no re-check-in → L  (LOP)
 *   leave_status === 'Rejected' + re-checked in  → P / OD (normal attendance)
 *
 * endDate always capped to yesterday for ATTENDANCE exports (today is incomplete)
 * Leave exports: NO cap — leaves are complete records
 * Signature row: Employee Sign (left) + Manager Sign (right) — side by side
 *
 * Override mutex:
 *   After manager acts, EITHER hr OR super_admin can override (first-wins).
 *   Once one party overrides, the other sees the remark but cannot override again.
 */
'use strict';

const express  = require('express');
const router   = express.Router();
const ExcelJS  = require('exceljs');
const PDFDoc   = require('pdfkit');
const mongoose = require('mongoose');
const { AttendanceRecord, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// ── Tripura blocks & districts ────────────────────────────────────────────────
const TRIPURA_BLOCKS = [
  'Agartala','Amarpur','Ambassa','Bagafa','Belonia','Bishalgarh','Boxanagar',
  'Dhalai','Dharmanagar','Gandacherra','Jampui Hills','Jolaibari','Jirania',
  'Kakraban','Kamalpur','Kanchanpur','Karbook','Khowai','Lefunga',
  'Longtarai Valley','Majlishpur','Matarbari','Melaghar','Mohanpur',
  'Mungiakami','Murasingh','Nasingh Para','Padmabil','Panisagar',
  'Ramchandraghat','Rupaichari','Sabroom','Salema','Sonamura','Surma','Teliamura',
];
const TRIPURA_DISTRICTS = [
  'Dhalai','Gomati','Khowai','North Tripura','Sepahijala',
  'South Tripura','Unakoti','West Tripura',
];
const ALL_TRIPURA = [...TRIPURA_BLOCKS, ...TRIPURA_DISTRICTS, 'Tripura'];

const isInTripura = addr => {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return ALL_TRIPURA.some(loc => a.includes(loc.toLowerCase()));
};

const matchesLocation = (addr, locationName) => {
  if (!addr || !locationName) return false;
  return addr.toLowerCase().includes(locationName.toLowerCase());
};

// ── IST helpers ───────────────────────────────────────────────────────────────
const IST      = 'Asia/Kolkata';
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: IST });
const toObjId  = id => { try { return new mongoose.Types.ObjectId(String(id)); } catch { return id; } };
const yesterdayIST = () => {
  const d = new Date(); d.setDate(d.getDate()-1);
  return d.toLocaleDateString('en-CA', { timeZone: IST });
};

const expandDates = (start, end) => {
  const out = [];
  let cur = new Date(start+'T00:00:00+05:30');
  const fin = new Date(end +'T00:00:00+05:30');
  while (cur <= fin) {
    out.push(cur.toLocaleDateString('en-CA', { timeZone: IST }));
    cur.setDate(cur.getDate()+1);
  }
  return out;
};

const HOLIDAYS_MMDD = new Set([
  '01-14','01-23','01-26','03-04','03-21','04-03','04-14','04-15','04-21',
  '05-01','05-26','05-27','06-26','07-22','08-04','08-15','08-19','08-26',
  '09-04','10-02','10-17','10-19','10-20','10-21','10-22','10-23','10-26',
  '11-09','12-25',
]);
const RESTRICTED_MMDD = new Set([
  '01-01','03-03','03-25','03-31','06-20','07-16','08-12','08-28',
  '09-11','09-18','11-11','11-24','12-03','12-24',
]);

const isHoliday = iso => {
  const mmdd = iso.substring(5);
  return HOLIDAYS_MMDD.has(mmdd) || RESTRICTED_MMDD.has(mmdd);
};

const getNthSaturday = iso => {
  const d = new Date(iso + 'T00:00:00+05:30');
  if (d.getDay() !== 6) return 0;
  let count = 0;
  for (let i = 1; i <= d.getDate(); i++) {
    if (new Date(d.getFullYear(), d.getMonth(), i).getDay() === 6) count++;
  }
  return count;
};

const isNonWorkingDay = iso => {
  const dow = new Date(iso + 'T00:00:00+05:30').getDay();
  if (dow === 0) return true;                          // Sunday
  if (dow === 6) return true;
  return false;
};

const isWeekend = iso => isNonWorkingDay(iso); // kept for PDF total WO count
const dayNum    = iso => new Date(iso+'T00:00:00+05:30').getDate();
const monAbbr   = iso => new Date(iso+'T00:00:00+05:30').toLocaleDateString('en-IN',{timeZone:IST,month:'short'});
const ordinal   = n   => { const s=['th','st','nd','rd'],v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); };
const colLetter = n   => { let s='',c=n; while(c>0){s=String.fromCharCode(65+(c-1)%26)+s;c=Math.floor((c-1)/26);} return s; };

/**
 * toCode — determines cell code for one attendance record
 *
 * Leave status rules:
 *   Pending  → '' (blank — not yet decided, don't mark absent)
 *   Approved → 'L'
 *   Rejected + no re-check-in → 'L' (LOP / loss-of-pay)
 *   Rejected + re-checked in  → fall through to P/OD location logic
 *
 * Regular attendance:
 *   Rejected → 'A'
 *   Present with location → P or OD
 */
// const toCode = (rec, assignedBlock, assignedDistrict) => {
//   if (!rec) return 'A';

//   // ── Leave records ──────────────────────────────────────────────────────────
//   const isLeave = rec.duty_type === 'Leave' || (rec.leave_type && String(rec.leave_type).trim());
//   if (isLeave) {
//     const ls = rec.leave_status || rec.status || 'Pending';
//     if (ls === 'Pending')  return '';   // leave pending → blank (don't penalise)
  
// if (ls === 'Approved') {
//   const isHalfDay = String(rec.leave_type || '').toLowerCase().includes('half');
//   const hasCheckin = rec.checkin_time || rec.checkinTime;
//   if (!(isHalfDay && hasCheckin)) return 'L';
//   // Half Day + has check-in → fall through to P / OD logic below
// }
//     if (ls === 'Rejected') {
//       // Employee re-checked in after rejection → treat as normal attendance
//       const hasCheckin = rec.checkin_time || rec.checkinTime;
//       if (!hasCheckin) return 'L'; // rejected + no re-check-in → L (LOP)
//       // Has a real check-in after rejection → fall through to P/OD logic below
//     }
//   }

//   // ── Regular attendance (or rejected leave with actual re-check-in) ─────────
//   if (rec.status === 'Rejected') return 'A';

//   const addr = rec.location_address || rec.locationAddress || '';

//   // No assignment → always P (can't determine otherwise)
//   if (!assignedBlock && !assignedDistrict) return 'P';

//   const matchesAssigned =
//     (assignedBlock    && matchesLocation(addr, assignedBlock))   ||
//     (assignedDistrict && matchesLocation(addr, assignedDistrict));

//   if (matchesAssigned)  return 'P';   // at assigned workplace
//   if (isInTripura(addr)) return 'OD'; // elsewhere in Tripura
//   return ''; // outside all known Tripura locations
// };

// ── reports.js  ·  toCode() ───────────────────────────────────────────────
const toCode = (rec, assignedBlock, assignedDistrict) => {
  if (!rec) return 'A';

  // ── Leave records ──────────────────────────────────────────────────────────
  const isLeave = rec.duty_type === 'Leave' || (rec.leave_type && String(rec.leave_type).trim());
  if (isLeave) {
    const ls = rec.leave_status || rec.status || 'Pending';
    if (ls === 'Pending') return '';
    if (ls === 'Approved') {
      const isHalfDay = String(rec.leave_type || '').toLowerCase().includes('half');
      const hasCheckin = rec.checkin_time || rec.checkinTime;
      if (!(isHalfDay && hasCheckin)) return 'L';
      // Half Day + has check-in → fall through to attendance logic below
    }
    if (ls === 'Rejected') {
      const hasCheckin = rec.checkin_time || rec.checkinTime;
      if (!hasCheckin) return 'L';
      // Has a real check-in after rejection → fall through
    }
  }

  // ── Regular attendance ─────────────────────────────────────────────────────
  if (rec.status === 'Rejected') return 'A';

  // ✅ NEW: duty_type drives P vs OD — location is only a fallback
  const dutyType = (rec.duty_type || '').trim();

  if (dutyType === 'On Duty') return 'OD';   // employee chose "On Duty (Field)"

  // dutyType === 'Office Duty' (or blank/unknown) → location-based check
  const addr = rec.location_address || rec.locationAddress || '';

  // No assignment → always P
  if (!assignedBlock && !assignedDistrict) return 'P';

  const matchesAssigned =
    (assignedBlock    && matchesLocation(addr, assignedBlock))   ||
    (assignedDistrict && matchesLocation(addr, assignedDistrict));

  if (matchesAssigned)   return 'P';    // at assigned workplace
  if (isInTripura(addr)) return 'OD';   // elsewhere in Tripura (location fallback)
  return '';                            // outside all known locations
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/export
//  Attendance matrix export (Excel / PDF)
//  Supports:  empId, managerId  query params for HR / super_admin filtered downloads
// ══════════════════════════════════════════════════════════════════════════════
router.get('/export',
  authenticate,
  authorize('super_admin','admin','hr','manager','employee'),
  async (req, res) => {
  try {
    const { format='excel', status, empId, managerId } = req.query;
    const role = req.user.role;
    let { startDate, endDate } = req.query;

    if (!startDate||!endDate)
      return res.status(400).json({success:false,message:'startDate and endDate are required'});

    // Cap endDate to yesterday — today is never shown (incomplete day)
    if (endDate >= todayIST()) endDate = yesterdayIST();
    if (startDate > endDate)
      return res.status(400).json({success:false,message:'No completed dates in range. Report covers up to yesterday.'});

    const dates      = expandDates(startDate, endDate);
    const multiMonth = new Date(startDate+'T00:00:00+05:30').getMonth() !==
                       new Date(endDate  +'T00:00:00+05:30').getMonth();
    const totalDays  = dates.length;
 const woCount    = dates.filter(isNonWorkingDay).length;
    const holCount   = dates.filter(d => !isNonWorkingDay(d) && isHoliday(d)).length;
    // ── Employee list ──────────────────────────────────────────────────────────
    // Priority: employee (own) → specific empId → managerId team → manager (own team) → all
    let employees = [];

    if (role === 'employee') {
      // Always own record only
      const me = await User.findById(req.user.id)
        .select('_id name emp_id created_at assigned_block assigned_district').lean();
      if (me) employees = [me];

    } else if (empId && String(empId).trim() !== '') {
      // Specific employee selected in dropdown (any privileged role)
      const specific = await User.findById(toObjId(empId))
        .select('_id name emp_id created_at assigned_block assigned_district').lean();
      if (specific) employees = [specific];
      else return res.status(404).json({success:false,message:'Selected employee not found'});

    } else if (managerId && String(managerId).trim() !== '') {
      // Manager's entire team selected (HR / super_admin / admin use-case)
      employees = await User.find({ manager_id:toObjId(managerId), is_active:{$ne:false} })
        .select('_id name emp_id created_at assigned_block assigned_district').sort({emp_id:1}).lean();

    } else if (role === 'manager') {
      // Manager viewing own team
      employees = await User.find({ manager_id:toObjId(req.user.id), is_active:{$ne:false} })
        .select('_id name emp_id created_at assigned_block assigned_district').sort({emp_id:1}).lean();

    } else {
      // admin / hr / super_admin — all employees
      employees = await User.find({ role:'employee', is_active:{$ne:false} })
        .select('_id name emp_id created_at assigned_block assigned_district').sort({emp_id:1}).lean();
    }

    if (!employees.length)
      return res.status(404).json({success:false,message:'No employees found'});

    // ── Manager name for signature ─────────────────────────────────────────────
    let managerName = '';
    if (role === 'manager') {
      const mgr = await User.findById(req.user.id).select('name').lean();
      managerName = mgr?.name || '';
    } else if (role === 'employee') {
      const emp = await User.findById(req.user.id).select('manager_id').lean();
      if (emp?.manager_id) {
        const mgr = await User.findById(emp.manager_id).select('name').lean();
        managerName = mgr?.name || '';
      }
    } else if (managerId && String(managerId).trim() !== '') {
      // HR/super_admin filtered by a specific manager — show that manager's name
      const mgr = await User.findById(toObjId(managerId)).select('name').lean();
      managerName = mgr?.name || '';
    }
    // admin/hr/super_admin without manager filter → no single manager; leave blank

    // ── Attendance records ─────────────────────────────────────────────────────
    const recFilter = {
      date:   {$gte:startDate,$lte:endDate},
      emp_id: {$in:employees.map(e=>e._id)},
    };
    if (status && status !== 'All') recFilter.status = status;
    const rawRecs = await AttendanceRecord.find(recFilter).sort({date:1}).lean();

    // Build index — prefer real check-in records over rejected leave records for the same date
    const recIdx = {};
    for (const r of rawRecs) {
      const eid = String(r.emp_id);
      if (!recIdx[eid]) recIdx[eid] = {};
      const existing = recIdx[eid][r.date];
      const existingIsRejectedLeave =
        existing &&
        (existing.duty_type === 'Leave' || (existing.leave_type && String(existing.leave_type).trim())) &&
        (existing.leave_status === 'Rejected' || existing.status === 'Rejected');
      // Replace if no existing record, or if existing is a rejected leave (prefer real check-in)
      if (!existing || existingIsRejectedLeave) {
        recIdx[eid][r.date] = r;
      }
    }

    // ── Build cell matrix ──────────────────────────────────────────────────────
    const matrix = employees.map(emp => {
      const joinDate = emp.created_at
        ? new Date(emp.created_at).toLocaleDateString('en-CA', { timeZone: IST })
        : null;
      const ab = emp.assigned_block    || null;
      const ad = emp.assigned_district || null;

    return {
        emp,
        cells: dates.map(iso => {
          if (isNonWorkingDay(iso))           return 'WO'; // Sunday or 2nd/4th Sat
          if (joinDate && iso < joinDate)     return '';   // pre-join → blank
          if (isHoliday(iso))                 return 'H';  // public holiday
          const rec = recIdx[String(emp._id)]?.[iso];
          return toCode(rec, ab, ad);
        }),
      };
    });

    const sd = new Date(startDate+'T00:00:00+05:30');
    const ed = new Date(endDate  +'T00:00:00+05:30');
    const rangeTitle =
      `for the period ${ordinal(sd.getDate())} ` +
      `${sd.toLocaleDateString('en-IN',{timeZone:IST,month:'short'})}- ${sd.getFullYear()} To ` +
      `${ordinal(ed.getDate())} ${ed.toLocaleDateString('en-IN',{timeZone:IST,month:'long'})} ${ed.getFullYear()}`;

    // ══════════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════════
    if (format==='excel') {
      const wb = new ExcelJS.Workbook(); wb.creator='RAMP AMS';

      const FILL_RED  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFF4444'}};
      const FILL_WO   = {type:'pattern',pattern:'solid',fgColor:{argb:'FFBDD7EE'}};
      const FILL_WHT  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFFFFF'}};
      const FILL_ALT  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFF7F7F7'}};
      const FILL_SUBH = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE8EDF4'}};

   const FILL_HOL  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF3CD'}};
      const codeFill = (code, rf) => {
        if (code==='L'||code==='A') return FILL_RED;
        if (code==='WO')            return FILL_WO;
        if (code==='H')             return FILL_HOL;
        return rf;
      };   

      const TH  = ()=>({style:'thin',  color:{argb:'FFCCCCCC'}});
      const MED = ()=>({style:'medium',color:{argb:'FF999999'}});
      const CBDR = {top:TH(),bottom:TH(),left:TH(),right:TH()};
      const mc  = (ws,r1,c1,r2,c2)=>ws.mergeCells({top:r1,left:c1,bottom:r2,right:c2});
      const outerBorder = (ws,r1,c1,r2,c2)=>{
        for(let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++)
          ws.getCell(r,c).border={
            top:   r===r1?MED():TH(), bottom:r===r2?MED():TH(),
            left:  c===c1?MED():TH(), right: c===c2?MED():TH(),
          };
      };

      const buildSheet = (ws, empList, sheetTitle, mgrName,hCount=0) => {
        const LAST = 3+dates.length;

        // ── Rows 1-3: header ──────────────────────────────────────────────────
        mc(ws,1,2,1,LAST);
        Object.assign(ws.getCell(1,2),{value:'Attendance details of BRP',font:{bold:true,size:13,name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(1).height=24;

        mc(ws,2,2,2,LAST);
        Object.assign(ws.getCell(2,2),{value:rangeTitle,font:{bold:true,size:11,name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(2).height=18;

        const half=2+Math.floor(dates.length/2);
        mc(ws,3,2,3,half-1);
        Object.assign(ws.getCell(3,2),{value:'Location Name: Tripura',font:{bold:true,size:10,name:'Calibri'},alignment:{horizontal:'left',vertical:'center'}});
        mc(ws,3,half,3,LAST);
        Object.assign(ws.getCell(3,half),{value:'Project Name: Block Resource Person',font:{bold:true,size:10,name:'Calibri'},alignment:{horizontal:'left',vertical:'center'}});
        ws.getRow(3).height=16;

        // ── Row 4: column headers ─────────────────────────────────────────────
        ws.getRow(4).height=multiMonth?30:18;
        ws.getColumn(2).width=9; ws.getColumn(3).width=16;
        const HF={bold:true,size:9,color:{argb:'FF3366FF'},name:'Calibri'};
        const setHdr=(col,val)=>{
          const c=ws.getCell(4,col); c.value=val; c.font=HF; c.fill=FILL_WHT; c.border=CBDR;
          c.alignment={horizontal:'center',vertical:'center',wrapText:multiMonth&&col>3};
          ws.getColumn(col).width=col===2?9:col===3?16:4.2;
        };
        setHdr(2,'Emp code'); setHdr(3,'Employee Name');
        dates.forEach((iso,i)=>setHdr(4+i,multiMonth?`${dayNum(iso)}\n${monAbbr(iso)}`:String(dayNum(iso))));

        // ── Data rows ─────────────────────────────────────────────────────────
        empList.forEach(({emp,cells},idx)=>{
          const rowN=5+idx; ws.getRow(rowN).height=15;
          const rf=idx%2===0?FILL_WHT:FILL_ALT;
          const c2=ws.getCell(rowN,2); c2.value=emp.emp_id; c2.border=CBDR; c2.fill=rf; c2.alignment={horizontal:'center',vertical:'center',wrapText:false}; c2.font={size:10,name:'Calibri'}; c2.protection={locked:true};
          const c3=ws.getCell(rowN,3); c3.value=emp.name;   c3.border=CBDR; c3.fill=rf; c3.alignment={horizontal:'left',  vertical:'center',wrapText:false}; c3.font={size:10,name:'Calibri'}; c3.protection={locked:true};
          cells.forEach((code,i)=>{
            const c=ws.getCell(rowN,4+i); c.value=code; c.border=CBDR;
            c.alignment={horizontal:'center',vertical:'center',wrapText:false};
            c.font={bold:!!code,size:9,name:'Calibri',color:{argb:(code==='L'||code==='A')?'FFFFFFFF':'FF000000'}};
            c.fill=codeFill(code,rf); c.protection={locked:true};
          });
        });

        // ── Legend ────────────────────────────────────────────────────────────
        const legendRow=5+empList.length+1; ws.getRow(legendRow).height=14;
       const FILL_AMB = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF3CD'}};
        [{code:'P',label:'Present (assigned location)',isRed:false},
         {code:'OD',label:'On Duty (other Tripura location)',isRed:false},
         {code:'H',label:'Public Holiday',isRed:false,isAmber:true},
         {code:'L',label:'Leave / LOP',isRed:true},
         {code:'A',label:'Absent',isRed:true},
         {code:'WO',label:'Week Off',isRed:false},
        ].forEach(({code,label,isRed,isAmber},i)=>{
          const cc=ws.getCell(legendRow,4+i*2);
          cc.value=code; cc.fill=isRed?FILL_RED:isAmber?FILL_AMB:FILL_WHT; cc.border=CBDR;
          cc.alignment={horizontal:'center',vertical:'center'};
          cc.font={bold:true,size:8,name:'Calibri',color:{argb:isRed?'FFFFFFFF':isAmber?'FFD97706':'FF000000'}};
          ws.getCell(legendRow,4+i*2+1).value=label;
          ws.getCell(legendRow,4+i*2+1).font={size:8,name:'Calibri',italic:true};
        
        });

        // ── Summary ───────────────────────────────────────────────────────────
        const fDC=colLetter(4), lDC=colLetter(3+dates.length);
        let r=legendRow+2; const SR=r;
        ws.getColumn(2).width=28; ws.getColumn(3).width=12;
        const TF={bold:true,size:11,color:{argb:'FFC00000'},name:'Calibri'};
        const LF={bold:true,size:10,color:{argb:'FF1F3864'},name:'Calibri'};

        mc(ws,r,2,r,3);
        Object.assign(ws.getCell(r,2),{value:sheetTitle,fill:FILL_WHT,font:TF,alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(r).height=18;

        const sumRow=(label,value)=>{
          r++; ws.getRow(r).height=16;
          Object.assign(ws.getCell(r,2),{value:label,fill:FILL_WHT,font:LF,alignment:{horizontal:'left',vertical:'center'}});
          const vc=ws.getCell(r,3);
          const isF=typeof value==='string'&&value.startsWith('=');
          vc.value=isF?{formula:value.slice(1)}:value;
          vc.fill=FILL_WHT; vc.font=LF; vc.alignment={horizontal:'center',vertical:'center'}; vc.protection={locked:true};
        };

        sumRow('No of Total Days',totalDays);
        sumRow('No of Weekoff (WO)',woCount);
        sumRow('No of Holidays (H)',hCount);

        if(empList.length===1){
          const er=5;
          sumRow('No of Present / worked (P+OD)',`=COUNTIF(${fDC}${er}:${lDC}${er},"P")+COUNTIF(${fDC}${er}:${lDC}${er},"OD")`);
          sumRow('No of Leaves (L)',`=COUNTIF(${fDC}${er}:${lDC}${er},"L")`);
          sumRow('No of Absent (A)',`=COUNTIF(${fDC}${er}:${lDC}${er},"A")`);
        } else {
          // ── Table header row ────────────────────────────────────────────────
          r++; ws.getRow(r).height = 17;
          ws.getColumn(2).width = 22; ws.getColumn(3).width = 16;
          ws.getColumn(4).width = 14; ws.getColumn(5).width = 14;

          [['Employee Name','FF1F3864'], ['Present / Worked','FF047857'], ['No of Leaves','FFB45309'], ['No of Absent','FFB91C1C']].forEach(([hdr, argb], i) => {
            const c = ws.getCell(r, 2 + i);
            c.value = hdr; c.fill = FILL_SUBH; c.border = CBDR;
            c.font = { bold: true, size: 10, color: { argb }, name: 'Calibri' };
            c.alignment = { horizontal: 'center', vertical: 'center' };
          });

          // ── One row per employee ────────────────────────────────────────────
          empList.forEach(({ emp }, idx) => {
            r++; ws.getRow(r).height = 15;
            const rf  = idx % 2 === 0 ? FILL_WHT : FILL_ALT;
            const er  = 5 + idx;

            const cn = ws.getCell(r, 2);
            cn.value = emp.name; cn.fill = rf; cn.border = CBDR;
            cn.font = { size: 10, name: 'Calibri' };
            cn.alignment = { horizontal: 'left', vertical: 'center' };

            const cp = ws.getCell(r, 3);
            cp.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"P")+COUNTIF(${fDC}${er}:${lDC}${er},"OD")` };
            cp.fill = rf; cp.border = CBDR;
            cp.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF047857' } };
            cp.alignment = { horizontal: 'center', vertical: 'center' };
            cp.protection = { locked: true };

            const cl = ws.getCell(r, 4);
            cl.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"L")` };
            cl.fill = rf; cl.border = CBDR;
            cl.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFB45309' } };
            cl.alignment = { horizontal: 'center', vertical: 'center' };
            cl.protection = { locked: true };

            const ca = ws.getCell(r, 5);
            ca.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"A")` };
            ca.fill = rf; ca.border = CBDR;
            ca.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFB91C1C' } };
            ca.alignment = { horizontal: 'center', vertical: 'center' };
            ca.protection = { locked: true };
          });
        }

        outerBorder(ws, SR, 2, r, 5);

        // ── Signatures ────────────────────────────────────────────────────────
        r+=3; ws.getRow(r).height=20;

        if (role === 'employee') {
          // Employee download: Employee sign (left) + Manager sign (right)
          ws.getCell(r,2).value='Employee Sign:';
          ws.getCell(r,2).font={bold:true,size:10,name:'Calibri',color:{argb:'FF1F3864'}};
          mc(ws,r,3,r,6);
          const empSigCell=ws.getCell(r,3);
          empSigCell.value='';
          empSigCell.alignment={horizontal:'center',vertical:'bottom'};
          empSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};

          ws.getCell(r,8).value='Manager Sign:';
          ws.getCell(r,8).font={bold:true,size:15,name:'Calibri',color:{argb:'FF1F3864'}};
          mc(ws,r,12,r,13);
          const mgrSigCell=ws.getCell(r,12);
          mgrSigCell.value=mgrName?`(${mgrName})`:'';
          mgrSigCell.font={italic:true,size:10,name:'Calibri',color:{argb:'FF555555'}};
          mgrSigCell.alignment={horizontal:'center',vertical:'bottom'};
          mgrSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};
        }
        // Manager / HR / super_admin / admin: no signature row on exported sheet

        ws.views=[{state:'frozen',xSplit:3,ySplit:4}];
        ws.pageSetup={
          paperSize:9, orientation:'landscape',
          fitToPage:true, fitToWidth:1, fitToHeight:0,
          printTitlesRow:'$1:$4',
          margins:{left:0.2,right:0.2,top:0.4,bottom:0.4,header:0.2,footer:0.2},
        };
        ws.protect('BRP-READONLY',{
          selectLockedCells:true,selectUnlockedCells:true,
          formatCells:false,insertRows:false,insertColumns:false,
          deleteRows:false,deleteColumns:false,sort:false,
        });
      };

      if(role==='employee'){
        buildSheet(wb.addWorksheet('My Attendance'),matrix,`${matrix[0]?.emp.name} Summary`,managerName,holCount);
      } else {
        const allName =role==='manager'?'Team Report':'All emp Reports';
        const allTitle=role==='manager'?'Team Summary':'Total Summary';
        buildSheet(wb.addWorksheet(allName),matrix,allTitle,managerName,holCount);
        matrix.forEach(({emp,cells})=>{
          const name=emp.name.replace(/[:\\/?*[\]]/g,'').substring(0,31);
          buildSheet(wb.addWorksheet(name),[{emp,cells}],`${emp.name} Summary`,managerName,holCount);
        });
      }

      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="BRP_Attendance_${startDate}_to_${endDate}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════════
    if(format==='pdf'){
      const doc=new PDFDoc({size:'A3',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28},autoFirstPage:true});
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="BRP_Attendance_${startDate}_to_${endDate}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      doc.pipe(res);

      const PW=doc.page.width,PH=doc.page.height,ML=28;
      const CC=52,CN=115,CT=36;
      const dW=Math.max(11,(PW-56-CC-CN-CT)/dates.length);
      const RH=14;
      const xC=ML,xN=ML+CC,xD=xN+CN,xT=xD+dates.length*dW,tW=xT+CT-ML;

      const addPage=()=>doc.addPage({size:'A3',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28}});

      const drawHdr=y=>{
        doc.rect(ML,y,tW,20).fill('#FFF').stroke('#AAA');
        doc.fillColor('#000').fontSize(12).font('Helvetica-Bold').text('Attendance details of BRP',ML,y+5,{width:tW,align:'center'});
        doc.rect(ML,y+20,tW,14).fill('#FFF').stroke('#AAA');
        doc.fillColor('#666').fontSize(8).font('Helvetica').text(rangeTitle,ML,y+23,{width:tW,align:'center'});
        doc.rect(ML,y+34,tW,12).fill('#FFF').stroke('#AAA');
        doc.fillColor('#000').fontSize(7).font('Helvetica-Bold')
           .text('Location: Tripura',ML+4,y+37).text('Project: Block Resource Person',ML+tW/2,y+37);
        const y2=y+46;
        [[xC,CC,'Emp code'],[xN,CN,'Employee Name']].forEach(([x,w,l])=>{
          doc.rect(x,y2,w,RH).fill('#FFF').stroke('#AAA');
          doc.fillColor('#3366FF').fontSize(7).font('Helvetica-Bold').text(l,x+2,y2+3,{width:w-4,align:'center'});
        });
        dates.forEach((iso,i)=>{
          const x=xD+i*dW;
          doc.rect(x,y2,dW,RH).fill('#FFF').stroke('#AAA');
          doc.fillColor('#3366FF').fontSize(6).font('Helvetica-Bold').text(String(dayNum(iso)),x+1,y2+3,{width:dW-2,align:'center'});
        });
        doc.rect(xT,y2,CT,RH).fill('#FFF').stroke('#AAA');
        doc.fillColor('#3366FF').fontSize(7).font('Helvetica-Bold').text('Total',xT+2,y2+3,{width:CT-4,align:'center'});
        return y2+RH;
      };

      let y=drawHdr(ML);
      matrix.forEach(({emp,cells},idx)=>{
        if(y+RH>PH-60){addPage();y=drawHdr(28);}
        const bg=idx%2===0?'#F9F9F9':'#FFF';
        doc.rect(ML,y,tW,RH).fill(bg).stroke('#CCC');
        doc.fillColor('#000').fontSize(7).font('Helvetica').text(emp.emp_id||'',xC+2,y+3,{width:CC-4,align:'center'});
        doc.font('Helvetica-Bold').text(emp.name,xN+2,y+3,{width:CN-4});
        let pres=0;
        cells.forEach((code,i)=>{
          const x=xD+i*dW;
          const isRed=code==='L'||code==='A';
          const cellBg=isRed?'#FF4444':code==='WO'?'#BDD7EE':code==='H'?'#FFF3CD':bg;
          doc.rect(x,y,dW,RH).fill(cellBg).stroke('#CCC');
          if(code){
            doc.fillColor(isRed?'#FFFFFF':code==='H'?'#D97706':'#000000').fontSize(6).font('Helvetica-Bold')
               .text(code,x+1,y+3,{width:dW-2,align:'center'});
          }
          if(code==='P'||code==='OD') pres++;
        });
        doc.rect(xT,y,CT,RH).fill('#FFF').stroke('#AAA');
        doc.fillColor('#000').fontSize(7).font('Helvetica-Bold').text(String(pres),xT+2,y+3,{width:CT-4,align:'center'});
        y+=RH;
      });

      // Legend
      y+=10; if(y+20>PH-80){addPage();y=40;}
      let lx=ML;
      [{code:'P',label:'Present (assigned location)',red:false},
       {code:'OD',label:'On Duty (other Tripura location)',red:false},
       {code:'L',label:'Leave / LOP',red:true},
       {code:'A',label:'Absent',red:true},
       {code:'WO',label:'Week Off',red:false},
      ].forEach(({code,label,red})=>{
        const bw=14,lw=76;
        doc.rect(lx,y,bw,10).fill(red?'#FF4444':'#FFFFFF').stroke('#999');
        doc.fillColor(red?'#FFFFFF':'#000000').fontSize(6).font('Helvetica-Bold').text(code,lx+1,y+2,{width:bw-2,align:'center'});
        doc.fillColor('#333').fontSize(7).font('Helvetica').text(label,lx+bw+2,y+1,{width:lw});
        lx+=bw+lw+4;
      });
      y+=18;

      // Summary
      y+=4; if(y+130>PH-60){addPage();y=40;}
      const SW=240,SRH=16,SX=ML; let sy=y;
      const pdfRow=(label,value,type='row')=>{
        if(type==='title'){doc.rect(SX,sy,SW,SRH).fill('#FFF').stroke('#000'); doc.fillColor('#C00000').fontSize(10).font('Helvetica-Bold').text(label,SX,sy+3,{width:SW,align:'center'});}
        else if(type==='sub'){doc.rect(SX,sy,SW,SRH).fill('#E8EDF4').stroke('#000'); doc.fillColor('#1F3864').fontSize(9).font('Helvetica-Bold').text(label,SX,sy+3,{width:SW,align:'center'});}
        else{
          doc.rect(SX,sy,SW*0.72,SRH).fill('#FFF').stroke('#000');
          doc.rect(SX+SW*0.72,sy,SW*0.28,SRH).fill('#FFF').stroke('#000');
          doc.fillColor('#1F3864').fontSize(9).font('Helvetica-Bold').text(label,SX+4,sy+3,{width:SW*0.68});
          if(value!==undefined) doc.text(String(value),SX+SW*0.72,sy+3,{width:SW*0.26,align:'center'});
        }
        sy+=SRH;
      };
      const summaryTitle=role==='employee'?`${matrix[0]?.emp.name} Summary`:role==='manager'?'Team Summary':'Total Summary';
      pdfRow(summaryTitle,undefined,'title');
      pdfRow('No of Total Days',totalDays);
      pdfRow('No of Weekoff (WO)',woCount);
      pdfRow('No of Holidays (H)',holCount);

      if (matrix.length === 1) {
        const cells = matrix[0].cells;
        pdfRow('No of Present / worked (P+OD)', cells.filter(c => c==='P'||c==='OD').length);
        pdfRow('No of Leaves (L)',               cells.filter(c => c==='L').length);
        pdfRow('No of Absent (A)',               cells.filter(c => c==='A').length);
      } else {
        sy++;
        const TW = SW;
        const C0 = TW * 0.46;
        const C1 = TW * 0.18;
        const C2 = TW * 0.18;
        const C3 = TW * 0.18;

        doc.rect(SX,        sy, C0, SRH).fill('#E8EDF4').stroke('#000');
        doc.rect(SX+C0,     sy, C1, SRH).fill('#D1FAE5').stroke('#000');
        doc.rect(SX+C0+C1,  sy, C2, SRH).fill('#FEF3C7').stroke('#000');
        doc.rect(SX+C0+C1+C2, sy, C3, SRH).fill('#FEE2E2').stroke('#000');

        doc.fillColor('#1F3864').fontSize(8).font('Helvetica-Bold').text('Employee',   SX+4,    sy+4, {width:C0-8});
        doc.fillColor('#047857').fontSize(8).font('Helvetica-Bold').text('Present',    SX+C0,   sy+4, {width:C1,align:'center'});
        doc.fillColor('#B45309').fontSize(8).font('Helvetica-Bold').text('Leaves',     SX+C0+C1,sy+4, {width:C2,align:'center'});
        doc.fillColor('#B91C1C').fontSize(8).font('Helvetica-Bold').text('Absent',     SX+C0+C1+C2,sy+4,{width:C3,align:'center'});
        sy += SRH;

        matrix.forEach(({ emp, cells }, idx) => {
          const bg = idx % 2 === 0 ? '#FFFFFF' : '#F7F7F7';
          doc.rect(SX,          sy, C0, SRH).fill(bg).stroke('#CCCCCC');
          doc.rect(SX+C0,       sy, C1, SRH).fill(bg).stroke('#CCCCCC');
          doc.rect(SX+C0+C1,    sy, C2, SRH).fill(bg).stroke('#CCCCCC');
          doc.rect(SX+C0+C1+C2, sy, C3, SRH).fill(bg).stroke('#CCCCCC');

          const pres = cells.filter(c => c==='P'||c==='OD').length;
          const lv   = cells.filter(c => c==='L').length;
          const abs  = cells.filter(c => c==='A').length;

          doc.fillColor('#1F3864').fontSize(8.5).font('Helvetica-Bold').text(emp.name,     SX+4,   sy+3,{width:C0-8,lineBreak:false,ellipsis:true});
          doc.fillColor('#047857').fontSize(9  ).font('Helvetica-Bold').text(String(pres), SX+C0,  sy+3,{width:C1,align:'center'});
          doc.fillColor('#B45309').fontSize(9  ).font('Helvetica-Bold').text(String(lv),   SX+C0+C1,sy+3,{width:C2,align:'center'});
          doc.fillColor('#B91C1C').fontSize(9  ).font('Helvetica-Bold').text(String(abs),  SX+C0+C1+C2,sy+3,{width:C3,align:'center'});
          sy += SRH;
        });
      }

      // Signatures (employee download only)
      sy+=24; if(sy+30>PH-28){addPage();sy=40;}
      const sigLineW=140;

      if (role === 'employee') {
        doc.fillColor('#1F3864').fontSize(16).font('Helvetica-Bold').text('Employee Sign:',ML,sy);
        doc.moveTo(ML+90,sy+12).lineTo(ML+90+sigLineW,sy+12).stroke('#1F3864');

        const mgrSigX=ML+90+sigLineW+60;
        doc.fillColor('#1F3864').fontSize(16).font('Helvetica-Bold').text('Manager Sign:',mgrSigX,sy);
        doc.moveTo(mgrSigX+90,sy+12).lineTo(mgrSigX+90+sigLineW,sy+12).stroke('#1F3864');
        if(managerName){
          doc.fillColor('#555').fontSize(20).font('Helvetica-Oblique')
             .text(`(${managerName})`,mgrSigX+90,sy+14,{width:sigLineW,align:'center'});
        }
      }

      doc.end();
      return;
    }

    res.status(400).json({success:false,message:'format must be excel or pdf'});
  } catch(err){
    console.error('[ReportsExport]',err);
    res.status(500).json({success:false,message:'Export failed',error:err.message});
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/leave-export
// ══════════════════════════════════════════════════════════════════════════════
router.get('/leave-export',
  authenticate,
  authorize('super_admin', 'admin', 'hr', 'manager', 'employee'),
  async (req, res) => {
  try {
    const { format = 'excel', status, empId } = req.query;
    const role = req.user.role;
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate)
      return res.status(400).json({ success: false, message: 'startDate and endDate are required' });

    // NO cap to yesterday for leave reports — leaves are complete records
    if (startDate > endDate)
      return res.status(400).json({ success: false, message: 'startDate must be before or equal to endDate' });

    // ── Employee scope ─────────────────────────────────────────────────────────
    let employees = [];

    if (role === 'employee') {
      const me = await User.findById(req.user.id).select('_id name emp_id').lean();
      if (me) employees = [me];

    } else if (empId && String(empId).trim() !== '') {
      const specific = await User.findById(toObjId(empId)).select('_id name emp_id').lean();
      if (specific) employees = [specific];
      else return res.status(404).json({ success: false, message: 'Selected employee not found' });

    } else if (role === 'manager') {
      employees = await User.find({ manager_id: toObjId(req.user.id), is_active: { $ne: false } })
        .select('_id name emp_id').sort({ emp_id: 1 }).lean();

    } else {
      employees = await User.find({ role: 'employee', is_active: { $ne: false } })
        .select('_id name emp_id').sort({ emp_id: 1 }).lean();
    }

    if (!employees.length)
      return res.status(404).json({ success: false, message: 'No employees found' });

    // ── Fetch records ──────────────────────────────────────────────────────────
    const allRecs = await AttendanceRecord.find({
      date:   { $gte: startDate, $lte: endDate },
      emp_id: { $in: employees.map(e => e._id) },
    }).sort({ date: 1 }).lean();

    const leaveRecs = allRecs.filter(r =>
      r.duty_type === 'Leave' ||
      (r.leave_type && String(r.leave_type).trim() !== '')
    );

    const filtered = (status && status !== 'All')
      ? leaveRecs.filter(r => r.leave_status === status)
      : leaveRecs;

    const empMap = {};
    for (const e of employees) empMap[String(e._id)] = e;
const rows = filtered.map(r => {
  const startD    = r.date || '';
  const endD      = r.end_date || startD;
  const dayCount  = (startD && endD && endD !== startD)
    ? Math.round((new Date(endD) - new Date(startD)) / 86400000) + 1
    : 1;
  return {
    empCode:       empMap[String(r.emp_id)]?.emp_id || '',
    empName:       empMap[String(r.emp_id)]?.name   || '',
    startDate:     startD,
    endDate:       endD !== startD ? endD : '',
    days:          String(dayCount),
    leaveType:     r.leave_type     || '',
    status:        r.leave_status   || r.status || '',
    reason:        r.leave_reason   || '',
    managerRemark: r.manager_remark || '',
    hrOverride:    r.hr_override    ? 'Yes' : 'No',
    hrRemark:      r.hr_remark      || '',
  };
});

    const sd = new Date(startDate + 'T00:00:00+05:30');
    const ed = new Date(endDate   + 'T00:00:00+05:30');
    const rangeLabel =
      `${ordinal(sd.getDate())} ${sd.toLocaleDateString('en-IN', { timeZone: IST, month: 'short' })} ${sd.getFullYear()}` +
      ` To ` +
      `${ordinal(ed.getDate())} ${ed.toLocaleDateString('en-IN', { timeZone: IST, month: 'long' })} ${ed.getFullYear()}`;

    const reportTitle = employees.length === 1
      ? `Leave Report – ${employees[0].name} (${employees[0].emp_id || '—'})`
      : 'Leave Report – BRP (Block Resource Person)';

    const approved = rows.filter(r => r.status === 'Approved').length;
    const rejected = rows.filter(r => r.status === 'Rejected').length;
    const pending  = rows.filter(r => r.status === 'Pending').length;

    // ══════════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════════
    if (format === 'excel') {
      const wb = new ExcelJS.Workbook(); wb.creator = 'RAMP AMS';
      const ws = wb.addWorksheet('Leave Report');

      const FILL_HDR     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
      const FILL_SUB     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF4' } };
      const FILL_EVEN    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
      const FILL_ODD     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };
      const FILL_APPROVE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      const FILL_REJECT  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      const FILL_PENDING = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } };
      const CBDR = {
        top:    { style: 'thin', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        left:   { style: 'thin', color: { argb: 'FFCCCCCC' } },
        right:  { style: 'thin', color: { argb: 'FFCCCCCC' } },
      };
      const COLS = [
        { key: 'empCode',       header: 'Emp Code',      width: 12 },
        { key: 'empName',       header: 'Employee Name',  width: 22 },
         { key: 'startDate',     header: 'From Date',       width: 14 },
  { key: 'endDate',       header: 'To Date',         width: 14 },
   { key: 'days',          header: 'Days',            width:  7 },
        { key: 'leaveType',     header: 'Leave Type',     width: 18 },
        { key: 'status',        header: 'Status',         width: 14 },
        { key: 'reason',        header: 'Reason',         width: 32 },
        { key: 'managerRemark', header: 'Manager Remark', width: 28 },
        { key: 'hrOverride',    header: 'HR Override',    width: 13 },
        { key: 'hrRemark',      header: 'HR Remark',      width: 28 },
      ];
      const NC = COLS.length;

      ws.mergeCells(1, 1, 1, NC);
      Object.assign(ws.getCell(1, 1), {
        value: reportTitle,
        font:  { bold: true, size: 14, color: { argb: 'FFFFFFFF' }, name: 'Calibri' },
        fill:  FILL_HDR,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(1).height = 26;

      ws.mergeCells(2, 1, 2, NC);
      Object.assign(ws.getCell(2, 1), {
        value: `Period: ${rangeLabel}`,
        font:  { bold: true, size: 11, color: { argb: 'FF1F3864' }, name: 'Calibri' },
        fill:  FILL_SUB,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(2).height = 18;

      ws.mergeCells(3, 1, 3, NC);
      Object.assign(ws.getCell(3, 1), {
        value: `Total: ${rows.length}   |   Approved: ${approved}   |   Rejected: ${rejected}   |   Pending: ${pending}`,
        font:  { size: 10, italic: true, color: { argb: 'FF444444' }, name: 'Calibri' },
        fill:  FILL_SUB,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(3).height = 15;

      ws.getRow(4).height = 18;
      COLS.forEach((col, i) => {
        ws.getColumn(i + 1).width = col.width;
        const c = ws.getCell(4, i + 1);
        c.value = col.header;
        c.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
        c.fill  = FILL_HDR;
        c.border = CBDR;
        c.alignment = { horizontal: 'center', vertical: 'center' };
      });

      if (rows.length === 0) {
        ws.mergeCells(5, 1, 5, NC);
        Object.assign(ws.getCell(5, 1), {
          value: 'No leave records found for the selected period and filters.',
          font:  { italic: true, size: 10, color: { argb: 'FF888888' } },
          alignment: { horizontal: 'center', vertical: 'center' },
        });
        ws.getRow(5).height = 18;
      } else {
        rows.forEach((row, idx) => {
          const rowN = 5 + idx;
          ws.getRow(rowN).height = 15;
          let rowFill = idx % 2 === 0 ? FILL_EVEN : FILL_ODD;
          if      (row.status === 'Approved') rowFill = FILL_APPROVE;
          else if (row.status === 'Rejected') rowFill = FILL_REJECT;
          else if (row.status === 'Pending')  rowFill = FILL_PENDING;

          COLS.forEach((col, i) => {
            const c = ws.getCell(rowN, i + 1);
            c.value  = row[col.key] || '';
            c.fill   = rowFill;
            c.border = CBDR;
            c.font   = { size: 9, name: 'Calibri' };
            c.alignment = {
              horizontal: ['empCode','status','hrOverride','days','startDate','endDate'].includes(col.key) ? 'center' : 'left',
              vertical:   'center',
              wrapText:   ['reason','managerRemark','hrRemark'].includes(col.key),
            };
          });

          const sc = ws.getCell(rowN, 5);
          const statusColor =
            row.status === 'Approved' ? 'FF047857' :
            row.status === 'Rejected' ? 'FFB91C1C' : 'FFB45309';
          sc.font = { bold: true, size: 9, name: 'Calibri', color: { argb: statusColor } };
        });
      }

      ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 4 }];
      ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: NC } };
      ws.pageSetup = {
        paperSize: 9, orientation: 'landscape',
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        printTitlesRow: '$1:$4',
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Leave_Report_${startDate}_to_${endDate}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════════
    if (format === 'pdf') {
      const doc = new PDFDoc({
        size: 'A3', layout: 'landscape',
        margins: { top: 28, bottom: 28, left: 28, right: 28 },
        autoFirstPage: true,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Leave_Report_${startDate}_to_${endDate}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      doc.pipe(res);

      const ML      = 28;
      const usableW = doc.page.width - ML * 2;
     const colWidths = [48, 105, 58, 58, 28, 75, 62, 130, 120, 48, 105];
const colKeys   = ['empCode','empName','startDate','endDate','days','leaveType','status','reason','managerRemark','hrOverride','hrRemark'];
const colHdrs   = ['Emp Code','Employee Name','From Date','To Date','Days','Leave Type','Status','Reason','Manager Remark','HR Override','HR Remark'];
      const totalW    = colWidths.reduce((a, b) => a + b, 0);
      const cw        = colWidths.map(w => (w / totalW) * usableW);
      const RH = 14, HRH = 16;
      let y = ML;

      const drawPageHeader = (yy) => {
        doc.rect(ML, yy, usableW, 20).fill('#1F3864');
        doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold')
           .text(reportTitle, ML, yy + 5, { width: usableW, align: 'center' });
        yy += 20;
        doc.rect(ML, yy, usableW, 13).fill('#E8EDF4').stroke('#CCCCCC');
        doc.fillColor('#1F3864').fontSize(8).font('Helvetica')
           .text(
             `Period: ${rangeLabel}   |   Total: ${rows.length}   Approved: ${approved}   Rejected: ${rejected}   Pending: ${pending}`,
             ML + 4, yy + 3, { width: usableW - 8, align: 'center' }
           );
        yy += 13;
        let cx = ML;
        cw.forEach((w, i) => {
          doc.rect(cx, yy, w, HRH).fill('#1F3864').stroke('#AAAAAA');
          doc.fillColor('#FFFFFF').fontSize(6.5).font('Helvetica-Bold')
             .text(colHdrs[i], cx + 2, yy + 4, { width: w - 4, align: 'center' });
          cx += w;
        });
        return yy + HRH;
      };

      y = drawPageHeader(y);

      if (rows.length === 0) {
        doc.rect(ML, y, usableW, RH).fill('#FFFFFF').stroke('#CCCCCC');
        doc.fillColor('#888888').fontSize(8).font('Helvetica-Oblique')
           .text('No leave records found for the selected period and filters.', ML, y + 3, { width: usableW, align: 'center' });
      } else {
        rows.forEach((row, idx) => {
          if (y + RH > doc.page.height - 40) {
            doc.addPage({ size: 'A3', layout: 'landscape', margins: { top: 28, bottom: 28, left: 28, right: 28 } });
            y = drawPageHeader(28);
          }
          const bg =
            row.status === 'Approved' ? '#D1FAE5' :
            row.status === 'Rejected' ? '#FEE2E2' :
            row.status === 'Pending'  ? '#FFF9C4' :
            (idx % 2 === 0 ? '#FFFFFF' : '#F9F9F9');

          doc.rect(ML, y, usableW, RH).fill(bg).stroke('#DDDDDD');
          let cx = ML;
          colKeys.forEach((key, i) => {
            const val = String(row[key] || '');
            const isCenter = ['empCode','status','hrOverride','days','startDate','endDate'].includes(key);
            const textColor =
              key === 'status'
                ? (row.status === 'Approved' ? '#047857' : row.status === 'Rejected' ? '#B91C1C' : '#B45309')
                : '#000000';
            doc.rect(cx, y, cw[i], RH).stroke('#DDDDDD');
            doc.fillColor(textColor).fontSize(6)
               .font(key === 'status' ? 'Helvetica-Bold' : 'Helvetica')
               .text(val, cx + 2, y + 3, { width: cw[i] - 4, align: isCenter ? 'center' : 'left', lineBreak: false, ellipsis: true });
            cx += cw[i];
          });
          y += RH;
        });
      }

      doc.end();
      return;
    }

    res.status(400).json({ success: false, message: 'format must be excel or pdf' });
  } catch (err) {
    console.error('[LeaveExport]', err);
    res.status(500).json({ success: false, message: 'Leave export failed', error: err.message });
  }
});

// ── dashboard-stats ───────────────────────────────────────────────────────────
router.get('/dashboard-stats', authenticate, async (req,res)=>{
  try{
    const today=new Date().toISOString().split('T')[0];
    const thisMonth=today.substring(0,7);
    const empFilter={};
    if(req.user.role==='employee')     empFilter.emp_id    =toObjId(req.user.id);
    else if(req.user.role==='manager') empFilter.manager_id=toObjId(req.user.id);
    const monthStart=`${thisMonth}-01`;
    const [year,month]=thisMonth.split('-').map(Number);
    const nextMonth=month===12?`${year+1}-01-01`:`${year}-${String(month+1).padStart(2,'0')}-01`;
    const monthlyResult=await AttendanceRecord.aggregate([
      {$match:{date:{$gte:monthStart,$lt:nextMonth},...empFilter}},
      {$group:{_id:null,total:{$sum:1},approved:{$sum:{$cond:[{$eq:['$status','Approved']},1,0]}},pending:{$sum:{$cond:[{$eq:['$status','Pending']},1,0]}},rejected:{$sum:{$cond:[{$eq:['$status','Rejected']},1,0]}},on_duty:{$sum:{$cond:[{$eq:['$duty_type','On Duty']},1,0]}}}},
      {$project:{_id:0}},
    ]);
    const monthly=monthlyResult[0]||{total:0,approved:0,pending:0,rejected:0,on_duty:0};
    const sevenDaysAgo=new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate()-7);
    const trend=await AttendanceRecord.aggregate([
      {$match:{date:{$gte:sevenDaysAgo.toISOString().split('T')[0]},...empFilter}},
      {$group:{_id:'$date',count:{$sum:1},approved:{$sum:{$cond:[{$eq:['$status','Approved']},1,0]}}}},
      {$project:{_id:0,date:'$_id',count:1,approved:1}},
      {$sort:{date:1}},
    ]);
    res.json({success:true,data:{monthly,trend}});
  }catch(err){
    res.status(500).json({success:false,message:'Server error',error:err.message});
  }
});

module.exports = router;