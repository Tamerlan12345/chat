const { identity } = require('../db/identity');

class OrgService {
  /**
   * Все подразделения поддерева, включая корень. Используется везде, где
   * действует «контур» администратора подразделения.
   */
  static async getSubtreeDepartmentIds(rootDeptId) {
    if (!rootDeptId) return null;
    const all = await identity().all('SELECT id, parent_id FROM departments');

    const result = new Set([Number(rootDeptId)]);
    let added = true;
    while (added) {
      added = false;
      for (const dept of all) {
        if (dept.parent_id && result.has(Number(dept.parent_id)) && !result.has(Number(dept.id))) {
          result.add(Number(dept.id));
          added = true;
        }
      }
    }
    return Array.from(result);
  }

  static async getOrganizationTree(adminScopeDeptId = null) {
    const db = identity();

    const departments = await db.all(`
      SELECT id, parent_id, name, description, dept_type, sort_order, created_at
      FROM departments
      ORDER BY sort_order ASC, name ASC
    `);

    const users = await db.all(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.job_title, u.department_id,
             u.role_id, u.avatar_url, u.status, u.custom_status, u.last_seen, u.extension,
             r.name AS role_name
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1 AND u.approval_status = 'approved'
      ORDER BY u.full_name ASC
    `);

    const deptMap = {};
    for (const dept of departments) {
      deptMap[dept.id] = {
        ...dept,
        subDepartments: [],
        employees: [],
        totalStaffCount: 0,
        onlineStaffCount: 0
      };
    }

    const unassignedEmployees = [];
    for (const user of users) {
      if (user.department_id && deptMap[user.department_id]) {
        deptMap[user.department_id].employees.push(user);
      } else {
        unassignedEmployees.push(user);
      }
    }

    const rootDepartments = [];
    for (const dept of departments) {
      if (dept.parent_id && deptMap[dept.parent_id]) {
        deptMap[dept.parent_id].subDepartments.push(deptMap[dept.id]);
      } else {
        rootDepartments.push(deptMap[dept.id]);
      }
    }

    function calculateCounts(node) {
      let total = node.employees.length;
      let online = node.employees.filter((e) => e.status === 'online' || e.status === 'away').length;
      for (const sub of node.subDepartments) {
        const counts = calculateCounts(sub);
        total += counts.total;
        online += counts.online;
      }
      node.totalStaffCount = total;
      node.onlineStaffCount = online;
      return { total, online };
    }

    for (const root of rootDepartments) calculateCounts(root);

    let filteredTree = rootDepartments;
    if (adminScopeDeptId && deptMap[adminScopeDeptId]) {
      filteredTree = [deptMap[adminScopeDeptId]];
    }

    return {
      tree: filteredTree,
      unassigned: unassignedEmployees,
      totalUsers: users.length,
      onlineUsers: users.filter((u) => u.status === 'online' || u.status === 'away').length
    };
  }

  static async createDepartment({ parent_id, name, description, dept_type, sort_order } = {}) {
    if (!name || !String(name).trim()) throw new Error('Укажите название подразделения');

    const created = await identity().run(
      `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        parent_id ? Number(parent_id) : null,
        String(name).trim(),
        description || '',
        dept_type || 'department',
        Number(sort_order) || 0,
        new Date().toISOString()
      ]
    );

    return this.getDepartment(created.rows[0].id);
  }

  static async getDepartment(id) {
    return identity().get('SELECT * FROM departments WHERE id = $1', [Number(id)]);
  }

  static async updateDepartment(id, { name, description, dept_type, sort_order, parent_id } = {}) {
    // COALESCE рассчитан на NULL, а не на undefined: правка одного поля —
    // например переименование отдела — иначе падала целиком, ведь остальные
    // поля приходили пустыми.
    const orNull = (v) => (v === undefined ? null : v);

    if (parent_id !== undefined && parent_id !== null) {
      await this.assertNoCycle(Number(id), Number(parent_id));
    }

    await identity().run(
      `UPDATE departments
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           dept_type = COALESCE($3, dept_type),
           sort_order = COALESCE($4, sort_order),
           parent_id = COALESCE($5, parent_id)
       WHERE id = $6`,
      [
        orNull(name && String(name).trim()),
        orNull(description),
        orNull(dept_type),
        orNull(sort_order),
        orNull(parent_id),
        Number(id)
      ]
    );

    return this.getDepartment(id);
  }

  /**
   * Подразделение нельзя вложить в собственное поддерево: дерево превратится в
   * кольцо, а обход по нему — в бесконечный цикл, который увидит не тот, кто
   * это сделал, а все остальные.
   */
  static async assertNoCycle(id, newParentId) {
    if (id === newParentId) {
      throw new Error('Подразделение не может быть вложено само в себя');
    }
    const subtree = await this.getSubtreeDepartmentIds(id);
    if (subtree && subtree.includes(newParentId)) {
      throw new Error('Нельзя переместить подразделение внутрь его собственного подразделения');
    }
  }

  static async deleteDepartment(id) {
    const db = identity();
    const dept = await db.get('SELECT parent_id FROM departments WHERE id = $1', [Number(id)]);
    const parentId = dept ? dept.parent_id : null;

    await db.run('UPDATE departments SET parent_id = $1 WHERE parent_id = $2', [parentId, Number(id)]);
    await db.run('UPDATE users SET department_id = NULL WHERE department_id = $1', [Number(id)]);
    await db.run('UPDATE users SET admin_scope_dept_id = NULL WHERE admin_scope_dept_id = $1', [Number(id)]);
    await db.run('DELETE FROM departments WHERE id = $1', [Number(id)]);
    return true;
  }

  static async moveUser(userId, departmentId) {
    await identity().run('UPDATE users SET department_id = $1 WHERE id = $2', [
      departmentId ? Number(departmentId) : null,
      Number(userId)
    ]);
    return true;
  }
}

module.exports = OrgService;
