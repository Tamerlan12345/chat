const { getDatabase } = require('../db');

class OrgService {
  /**
   * Helper: Get all department IDs in a subtree (including root)
   */
  static getSubtreeDepartmentIds(rootDeptId) {
    if (!rootDeptId) return null;
    const db = getDatabase();
    const allDepts = db.prepare('SELECT id, parent_id FROM departments').all();
    
    const result = new Set([Number(rootDeptId)]);
    let added = true;
    while (added) {
      added = false;
      for (const d of allDepts) {
        if (d.parent_id && result.has(d.parent_id) && !result.has(d.id)) {
          result.add(d.id);
          added = true;
        }
      }
    }
    return Array.from(result);
  }

  /**
   * Get dynamic multi-level organization tree with recursive employee counts
   */
  static getOrganizationTree(adminScopeDeptId = null) {
    const db = getDatabase();

    const departments = db.prepare(`
      SELECT id, parent_id, name, description, dept_type, sort_order, created_at
      FROM departments
      ORDER BY sort_order ASC, name ASC
    `).all();

    const users = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.job_title, u.department_id, 
             u.role_id, u.avatar_url, u.status, u.custom_status, u.last_seen,
             u.extension, u.bound_ip,
             r.name as role_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.is_active = 1
      ORDER BY u.full_name ASC
    `).all();

    // Map users to departments
    const deptMap = {};
    for (const d of departments) {
      deptMap[d.id] = {
        ...d,
        subDepartments: [],
        employees: [],
        totalStaffCount: 0,
        onlineStaffCount: 0
      };
    }

    const unassignedEmployees = [];

    for (const u of users) {
      if (u.department_id && deptMap[u.department_id]) {
        deptMap[u.department_id].employees.push(u);
      } else {
        unassignedEmployees.push(u);
      }
    }

    // Build hierarchy tree
    const rootDepartments = [];
    for (const d of departments) {
      if (d.parent_id && deptMap[d.parent_id]) {
        deptMap[d.parent_id].subDepartments.push(deptMap[d.id]);
      } else {
        rootDepartments.push(deptMap[d.id]);
      }
    }

    // Recursive helper to aggregate totalStaffCount and onlineStaffCount
    function calculateCounts(node) {
      let total = node.employees.length;
      let online = node.employees.filter(e => e.status === 'online' || e.status === 'away').length;

      for (const sub of node.subDepartments) {
        const subCounts = calculateCounts(sub);
        total += subCounts.total;
        online += subCounts.online;
      }

      node.totalStaffCount = total;
      node.onlineStaffCount = online;
      return { total, online };
    }

    for (const root of rootDepartments) {
      calculateCounts(root);
    }

    // If scoped admin, return only that subtree
    let filteredTree = rootDepartments;
    if (adminScopeDeptId && deptMap[adminScopeDeptId]) {
      filteredTree = [deptMap[adminScopeDeptId]];
    }

    return {
      tree: filteredTree,
      unassigned: unassignedEmployees,
      totalUsers: users.length,
      onlineUsers: users.filter(u => u.status === 'online' || u.status === 'away').length
    };
  }

  static createDepartment({ parent_id, name, description, dept_type, sort_order }) {
    const db = getDatabase();
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(parent_id || null, name, description || '', dept_type || 'department', sort_order || 0, now);
    return { id: Number(result.lastInsertRowid), parent_id, name, description, dept_type: dept_type || 'department', sort_order };
  }

  static updateDepartment(id, { name, description, dept_type, sort_order, parent_id }) {
    const db = getDatabase();
    db.prepare(`
      UPDATE departments 
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          dept_type = COALESCE(?, dept_type),
          sort_order = COALESCE(?, sort_order),
          parent_id = COALESCE(?, parent_id)
      WHERE id = ?
    `).run(name, description, dept_type, sort_order, parent_id, id);
    return db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  }

  static deleteDepartment(id) {
    const db = getDatabase();
    const dept = db.prepare('SELECT parent_id FROM departments WHERE id = ?').get(id);
    const parentId = dept ? dept.parent_id : null;
    db.prepare('UPDATE departments SET parent_id = ? WHERE parent_id = ?').run(parentId, id);
    db.prepare('UPDATE users SET department_id = NULL WHERE department_id = ?').run(id);
    db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    return true;
  }

  static moveUser(userId, departmentId) {
    const db = getDatabase();
    db.prepare('UPDATE users SET department_id = ? WHERE id = ?').run(departmentId || null, userId);
    return true;
  }
}

module.exports = OrgService;
