const { getDatabase, hashPassword } = require('../db');
const OrgService = require('./org.service');
const wsServer = require('../ws/server');

// Cyrillic to Latin transliteration helper
function transliterate(str) {
  const ru = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
    'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
    'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
    'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu',
    'я': 'ya', 'ә': 'a', 'і': 'i', 'ң': 'n', 'ғ': 'g', 'ү': 'u', 'ұ': 'u', 'қ': 'k', 'ө': 'o', 'һ': 'h'
  };
  return str.toLowerCase().split('').map(c => ru[c] !== undefined ? ru[c] : c).join('').replace(/[^a-z0-9_]/g, '');
}

class OrgParserService {
  /**
   * Parse arbitrary raw text (Paths, Indents, CSV) into normalized structure
   */
  static parseRawText(rawText, formatHint = 'auto') {
    if (!rawText || !rawText.trim()) {
      return { departments: [], employees: [], tree: [], stats: { departmentsCount: 0, employeesCount: 0 } };
    }

    const lines = rawText.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
    
    // Auto-detect format if needed
    let detectedFormat = formatHint;
    if (detectedFormat === 'auto') {
      const hasCsvDelimiter = lines.some(l => l.includes(';') || (l.split(',').length >= 4));
      const hasSlashes = lines.some(l => l.includes('/') && l.split('/').length >= 2);
      const hasIndents = rawText.split(/\r?\n/).some(l => /^[ \t]{2,}/.test(l));

      if (hasCsvDelimiter) detectedFormat = 'csv';
      else if (hasSlashes) detectedFormat = 'path';
      else if (hasIndents) detectedFormat = 'indent';
      else detectedFormat = 'path';
    }

    if (detectedFormat === 'csv') {
      return this._parseCsv(lines);
    } else if (detectedFormat === 'indent') {
      return this._parseIndented(rawText);
    } else {
      return this._parsePaths(lines);
    }
  }

  /**
   * Format 1: Path-based parsing
   * Example: Компания / Департамент / Отдел / ФИО | login | ip | phone | job | email
   */
  static _parsePaths(lines) {
    const deptSet = new Set();
    const employees = [];

    for (const line of lines) {
      const parts = line.split('/').map(p => p.trim()).filter(Boolean);
      if (parts.length === 0) continue;

      if (parts.length === 1) {
        // Just a company or top dept
        deptSet.add(parts[0]);
        continue;
      }

      // Check if last part is an employee (contains |, or has multiple attributes)
      const lastPart = parts[parts.length - 1];
      const isEmployee = lastPart.includes('|') || lastPart.includes('(') || parts.length >= 3;

      if (isEmployee) {
        const deptPathParts = parts.slice(0, parts.length - 1);
        const deptPath = deptPathParts.join(' / ');
        
        // Register all intermediate department paths
        for (let i = 1; i <= deptPathParts.length; i++) {
          deptSet.add(deptPathParts.slice(0, i).join(' / '));
        }

        const emp = this._parseEmployeeString(lastPart, deptPath);
        if (emp) employees.push(emp);
      } else {
        // Register all department paths
        for (let i = 1; i <= parts.length; i++) {
          deptSet.add(parts.slice(0, i).join(' / '));
        }
      }
    }

    return this._buildResult(Array.from(deptSet), employees);
  }

  /**
   * Format 2: Indented text parsing (Tabs or 2+ Spaces)
   */
  static _parseIndented(rawText) {
    const lines = rawText.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
    const stack = []; // stack of { indent, name, path }
    const deptSet = new Set();
    const employees = [];

    for (const rawLine of lines) {
      const matchIndent = rawLine.match(/^([ \t]*)/);
      const indentLength = matchIndent ? matchIndent[1].replace(/\t/g, '  ').length : 0;
      const text = rawLine.trim();

      // Check if this line is an employee
      const isEmp = text.includes('|') || text.includes('(') || (stack.length >= 2 && !text.toLowerCase().includes('департамент') && !text.toLowerCase().includes('управление') && !text.toLowerCase().includes('отдел') && !text.toLowerCase().includes('филиал'));

      // Unwind stack to find parent
      while (stack.length > 0 && stack[stack.length - 1].indent >= indentLength) {
        stack.pop();
      }

      const parentPath = stack.length > 0 ? stack[stack.length - 1].path : '';

      if (isEmp && parentPath) {
        const emp = this._parseEmployeeString(text, parentPath);
        if (emp) employees.push(emp);
      } else {
        const currentPath = parentPath ? `${parentPath} / ${text}` : text;
        deptSet.add(currentPath);
        stack.push({ indent: indentLength, name: text, path: currentPath });
      }
    }

    return this._buildResult(Array.from(deptSet), employees);
  }

  /**
   * Format 3: CSV parsing (Company;Dept;Directorate;Unit;FullName;Login;IP;Phone;Job;Email)
   */
  static _parseCsv(lines) {
    const deptSet = new Set();
    const employees = [];

    let startIndex = 0;
    // Check if first line is header
    if (lines[0].toLowerCase().includes('фио') || lines[0].toLowerCase().includes('компания') || lines[0].toLowerCase().includes('департамент')) {
      startIndex = 1;
    }

    const delimiter = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';

    for (let i = startIndex; i < lines.length; i++) {
      const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
      if (cols.length < 2) continue;

      // Extract hierarchy columns and employee columns
      let company = cols[0] || 'АО СК Сентрас Иншуранс';
      let dept = cols[1] || '';
      let subdept = cols.length >= 6 ? cols[2] : '';
      let unit = cols.length >= 7 ? cols[3] : '';

      let fullName = '', username = '', ip = '', phone = '', job = '', email = '';

      if (cols.length >= 7) {
        fullName = cols[4];
        username = cols[5];
        ip = cols[6];
        phone = cols[7] || '';
        job = cols[8] || '';
        email = cols[9] || '';
      } else if (cols.length >= 5) {
        fullName = cols[2];
        username = cols[3];
        ip = cols[4];
        phone = cols[5] || '';
        job = cols[6] || '';
      } else {
        fullName = cols[cols.length - 1];
      }

      const pathParts = [company, dept, subdept, unit].filter(Boolean);
      for (let p = 1; p <= pathParts.length; p++) {
        deptSet.add(pathParts.slice(0, p).join(' / '));
      }

      if (fullName) {
        employees.push({
          full_name: fullName,
          username: username || transliterate(fullName),
          department_path: pathParts.join(' / '),
          bound_ip: ip || null,
          extension: phone || null,
          job_title: job || 'Сотрудник',
          email: email || null
        });
      }
    }

    return this._buildResult(Array.from(deptSet), employees);
  }

  static _parseEmployeeString(str, deptPath) {
    let fullName = str;
    let username = '';
    let ip = '';
    let phone = '';
    let job = '';
    let email = '';

    // Handle pipe delimited: Иванов Иван | iivanov | 192.168.10.45 | 2410 | Должность | email
    if (str.includes('|')) {
      const segs = str.split('|').map(s => s.trim());
      fullName = segs[0];
      username = segs[1] || '';
      ip = segs[2] || '';
      phone = segs[3] || '';
      job = segs[4] || '';
      email = segs[5] || '';
    } 
    // Handle parentheses: Иванов Иван (login: iivanov, ip: 192.168.10.45, вн. 2410)
    else if (str.includes('(') && str.includes(')')) {
      const m = str.match(/^(.*?)\s*\((.*?)\)$/);
      if (m) {
        fullName = m[1].trim();
        const inside = m[2];
        const tokens = inside.split(/[,;]/).map(t => t.trim());
        for (const tok of tokens) {
          if (tok.startsWith('login:') || tok.startsWith('логин:')) username = tok.split(':')[1].trim();
          else if (tok.startsWith('ip:')) ip = tok.split(':')[1].trim();
          else if (tok.startsWith('phone:') || tok.startsWith('вн:') || tok.startsWith('вн.')) phone = tok.replace(/^(phone|вн|вн\.):?\s*/i, '').trim();
          else if (tok.startsWith('job:') || tok.startsWith('должность:')) job = tok.split(':')[1].trim();
          else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tok)) ip = tok;
          else if (/^\d{3,5}$/.test(tok)) phone = tok;
          else if (tok.includes('@')) email = tok;
          else if (!username) username = tok;
        }
      }
    }

    if (!fullName) return null;

    if (!username) {
      username = transliterate(fullName);
    }

    return {
      full_name: fullName,
      username,
      department_path: deptPath,
      bound_ip: ip || null,
      extension: phone || null,
      job_title: job || 'Сотрудник',
      email: email || null
    };
  }

  static _buildResult(deptPaths, employees) {
    // Sort department paths by depth so parents come before children
    deptPaths.sort((a, b) => a.split(' / ').length - b.split(' / ').length);

    const deptsList = deptPaths.map(p => {
      const parts = p.split(' / ');
      const name = parts[parts.length - 1];
      const parent_path = parts.length > 1 ? parts.slice(0, parts.length - 1).join(' / ') : null;
      let dept_type = 'department';
      if (parts.length === 1) dept_type = 'company';
      else if (parts.length === 2) dept_type = 'branch';
      else if (name.toLowerCase().includes('управление')) dept_type = 'directorate';
      else if (name.toLowerCase().includes('отдел') || name.toLowerCase().includes('сектор')) dept_type = 'division';

      return {
        full_path: p,
        parent_path,
        name,
        dept_type,
        level: parts.length
      };
    });

    return {
      departments: deptsList,
      employees,
      stats: {
        departmentsCount: deptsList.length,
        employeesCount: employees.length,
        rootCompaniesCount: deptsList.filter(d => !d.parent_path).length
      }
    };
  }

  /**
   * Apply parsed hierarchy and users into database
   */
  static applyImport({ parsedData, defaultPassword = 'admin', adminScopeDeptId = null }) {
    const db = getDatabase();
    const now = new Date().toISOString();
    const { departments, employees } = parsedData;

    const pathIdMap = {}; // full_path -> department_id

    // Pre-load existing departments
    const existingDepts = db.prepare('SELECT id, parent_id, name, dept_type FROM departments').all();

    // Helper to find existing
    const findExisting = (name, parentId) => {
      return existingDepts.find(d => d.name === name && ((d.parent_id === parentId) || (!d.parent_id && !parentId)));
    };

    // A scoped ("Контурный") admin may only create/touch departments and
    // employees inside their own department subtree — otherwise batch import
    // is a way to reach outside the scope this role is supposed to enforce.
    // See docs/designs/auth-access-control-remediation.md item 14.
    const inScopeIds = adminScopeDeptId ? new Set(OrgService.getSubtreeDepartmentIds(adminScopeDeptId)) : null;

    let createdDepts = 0;
    let createdUsers = 0;
    let updatedUsers = 0;
    let skippedOutOfScope = 0;

    const insertDept = db.prepare(`
      INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `);

    // 1. Process Departments (deptPaths are pre-sorted parents-before-children)
    for (const d of departments) {
      const parentId = d.parent_path ? pathIdMap[d.parent_path] : null;

      if (inScopeIds) {
        if (!d.parent_path) {
          // Scoped admin can't create new top-level/company departments.
          skippedOutOfScope++;
          continue;
        }
        if (parentId === undefined || !inScopeIds.has(parentId)) {
          // Parent was itself skipped or is outside scope — cascade skip.
          skippedOutOfScope++;
          continue;
        }
      }

      let existing = findExisting(d.name, parentId);

      if (existing) {
        pathIdMap[d.full_path] = existing.id;
        if (inScopeIds) inScopeIds.add(existing.id);
      } else {
        const res = insertDept.run(parentId, d.name, `Импортировано: ${d.name}`, d.dept_type, now);
        const newId = Number(res.lastInsertRowid);
        pathIdMap[d.full_path] = newId;
        existingDepts.push({ id: newId, parent_id: parentId, name: d.name, dept_type: d.dept_type });
        if (inScopeIds) inScopeIds.add(newId);
        createdDepts++;
      }
    }

    // 2. Process Employees
    const pass = hashPassword(defaultPassword);
    const companyRow = db.prepare("SELECT value FROM server_settings WHERE key = 'company_name'").get();
    const companyName = companyRow ? companyRow.value : 'АО СК Сентрас Иншуранс';

    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, salt, full_name, email, phone, job_title, department_id, role_id, bound_ip, extension, company, created_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, 1)
    `);

    const updateUser = db.prepare(`
      UPDATE users
      SET full_name = COALESCE(?, full_name),
          department_id = COALESCE(?, department_id),
          bound_ip = COALESCE(?, bound_ip),
          extension = COALESCE(?, extension),
          job_title = COALESCE(?, job_title),
          email = COALESCE(?, email)
      WHERE id = ?
    `);

    for (const emp of employees) {
      const deptId = emp.department_path ? pathIdMap[emp.department_path] : null;

      if (inScopeIds && (deptId === undefined || deptId === null || !inScopeIds.has(deptId))) {
        skippedOutOfScope++;
        continue;
      }

      const existingUser = db.prepare('SELECT id, department_id FROM users WHERE username = ? OR (full_name = ? AND is_active = 1)').get(emp.username, emp.full_name);

      if (existingUser) {
        if (inScopeIds && (!existingUser.department_id || !inScopeIds.has(existingUser.department_id))) {
          // Existing employee currently sits outside this admin's scope —
          // don't let a batch import move them under a different manager's control.
          skippedOutOfScope++;
          continue;
        }
        updateUser.run(emp.full_name, deptId, emp.bound_ip, emp.extension, emp.job_title, emp.email, existingUser.id);
        updatedUsers++;
      } else {
        const res = insertUser.run(
          emp.username, pass.hash, pass.salt, emp.full_name,
          emp.email || null, null, emp.job_title || 'Сотрудник',
          deptId, emp.bound_ip || null, emp.extension || null,
          companyName, now
        );
        const newUid = Number(res.lastInsertRowid);

        // Add to system channels
        try {
          const sysChans = db.prepare("SELECT id FROM channels WHERE type = 'system'").all();
          for (const ch of sysChans) {
            db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(ch.id, newUid, 'member', now);
          }
        } catch {}

        createdUsers++;
      }
    }

    // Broadcast update
    try {
      wsServer.broadcast({
        type: 'org_tree_updated',
        stats: { createdDepts, createdUsers, updatedUsers }
      });
    } catch {}

    return {
      success: true,
      createdDepts,
      createdUsers,
      updatedUsers,
      skippedOutOfScope,
      totalEmployeesInDb: db.prepare('SELECT count(*) as c FROM users WHERE is_active = 1').get().c
    };
  }
}

module.exports = OrgParserService;
