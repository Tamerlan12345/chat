import React, { useState } from 'react';

export default function OrgTree({ treeData, onSelectUser, activeUserId, unreadMap = {}, error = null, onRetry = null }) {
  const [expandedNodes, setExpandedNodes] = useState({
    root: true,
    17: true,
    1: true,
    'АО СК Сентрас Иншуранс': true,
    'Головной Офис': true,
    'HR-Департамент': true,
    'Департамент Web-разработок': true
  });
  const [search, setSearch] = useState('');
  const [selectedDeptId, setSelectedDeptId] = useState(null);
  const [onlyOnline, setOnlyOnline] = useState(false);
  const [isCompact, setIsCompact] = useState(false);

  const toggleNode = (nodeKey) => {
    setExpandedNodes((prev) => ({
      ...prev,
      [nodeKey]: !prev[nodeKey]
    }));
  };

  const departments = treeData?.tree || [];
  const totalUsers = treeData?.totalUsers || 0;
  const onlineUsers = treeData?.onlineUsers || 0;

  // Toggle expand all or collapse all
  const handleToggleExpandAll = () => {
    const areSomeCollapsed = departments.some((d) => {
      const key = d.id || d.name;
      return !expandedNodes[key];
    });

    if (areSomeCollapsed) {
      const newExpanded = { root: true };
      const collectKeys = (depts) => {
        depts.forEach((d) => {
          newExpanded[d.id || d.name] = true;
          if (d.subDepartments) collectKeys(d.subDepartments);
        });
      };
      collectKeys(departments);
      setExpandedNodes(newExpanded);
    } else {
      const newExpanded = { root: true };
      if (departments[0]) {
        newExpanded[departments[0].id || departments[0].name] = true;
      }
      setExpandedNodes(newExpanded);
    }
  };

  // Helper to render employees under a department
  const renderEmployees = (employees = [], depth = 0) => {
    const q = search.trim().toLowerCase();
    let filtered = employees;

    if (onlyOnline) {
      filtered = filtered.filter((e) => e.status === 'online' || e.status === 'away');
    }

    if (q) {
      filtered = filtered.filter((e) =>
        (e.full_name || e.username || '').toLowerCase().includes(q) ||
        (e.job_title || '').toLowerCase().includes(q) ||
        String(e.extension || '').includes(q)
      );
    }

    // Flat calculated indentation (NO cumulative parent padding!)
    const indentPx = (depth + 1) * (isCompact ? 10 : 14) + 6;

    return filtered.map((emp) => {
      const isSelected = activeUserId === emp.id;
      const status = emp.status || 'offline';
      const statusLabel = status === 'online' ? 'В сети' : status === 'away' ? 'Отошел' : status === 'dnd' ? 'Не беспокоить' : 'Не в сети';
      const displayName = emp.full_name || emp.username;
      const unreadCount = unreadMap[emp.id] || 0;

      return (
        <div
          key={`emp_${emp.id}`}
          className={`tree-employee-node ${isSelected ? 'selected' : ''} ${unreadCount > 0 ? 'has-unread' : ''} ${isCompact ? 'compact' : ''}`}
          style={{ paddingLeft: `${indentPx}px` }}
          onClick={() => onSelectUser && onSelectUser(emp)}
          title={`${displayName} (${emp.job_title || 'Сотрудник'})\nСтатус: ${statusLabel}${emp.extension ? ' • вн. ' + emp.extension : ''}`}
        >
          <span className="tree-toggle-spacer" />
          <span className={`tree-presence-dot ${status}`} title={statusLabel} />
          <span className="tree-emp-name" style={{ fontWeight: unreadCount > 0 ? '700' : 'normal' }}>
            {displayName}
          </span>
          {emp.job_title && (
            <span className="tree-emp-job" title={emp.job_title}>
              {emp.job_title}
            </span>
          )}
          {emp.extension && (
            <span className="tree-emp-ext" title={`Внутренний номер: ${emp.extension}`}>
              вн.{emp.extension}
            </span>
          )}
          {unreadCount > 0 && (
            <span className="tree-unread-badge" title={`${unreadCount} непрочитанных сообщений`}>
              {unreadCount}
            </span>
          )}
        </div>
      );
    });
  };

  // Helper to render department node recursively
  const renderDepartment = (dept, depth = 0) => {
    const nodeKey = dept.id || dept.name;
    const isExpanded = expandedNodes[nodeKey] !== undefined ? expandedNodes[nodeKey] : (depth <= 1);
    const hasChildren = (dept.subDepartments && dept.subDepartments.length > 0) || (dept.employees && dept.employees.length > 0);

    const totalDeptUsers = dept.totalStaffCount !== undefined
      ? dept.totalStaffCount
      : ((dept.employees?.length || 0) + (dept.subDepartments?.reduce((acc, sub) => acc + (sub.employees?.length || 0), 0) || 0));

    const activeDeptUsers = dept.onlineStaffCount !== undefined
      ? dept.onlineStaffCount
      : ((dept.employees?.filter((e) => e.status === 'online' || e.status === 'away').length || 0) +
        (dept.subDepartments?.reduce((acc, sub) => acc + (sub.employees?.filter((e) => e.status === 'online' || e.status === 'away').length || 0), 0) || 0));

    if (onlyOnline && activeDeptUsers === 0) {
      return null;
    }

    const isSelected = selectedDeptId === dept.id;
    const isCompany = dept.dept_type === 'company' || depth === 0;
    const icon = isCompany ? '🏢' : dept.dept_type === 'branch' ? '🏛️' : '👥';

    // Flat calculated indentation
    const indentPx = depth * (isCompact ? 10 : 14) + 6;

    return (
      <div key={`dept_${dept.id}`} className="tree-dept-container">
        <div
          className={`${isCompany ? 'tree-root-row' : 'tree-dept-row'} ${isSelected ? 'active-selection' : ''} ${isCompact ? 'compact' : ''}`}
          style={{ paddingLeft: `${indentPx}px` }}
          onClick={() => {
            setSelectedDeptId(dept.id);
            toggleNode(nodeKey);
          }}
          title={`${dept.name} (${dept.dept_type || 'подразделение'})\nВ сети: ${activeDeptUsers} из ${totalDeptUsers}`}
        >
          <span className="tree-toggle-icon">
            {hasChildren ? (
              <span className="toggle-arrow">{isExpanded ? '▼' : '▶'}</span>
            ) : (
              <span className="tree-toggle-spacer" />
            )}
          </span>
          <span className={isCompany ? 'tree-root-icon' : 'tree-folder-icon'}>{icon}</span>
          <span className="tree-dept-name-text">
            {dept.name}
          </span>
          <span
            className={`tree-count-pill ${activeDeptUsers > 0 ? 'has-online' : 'all-offline'}`}
            title={`В сети: ${activeDeptUsers} / Всего: ${totalDeptUsers}`}
          >
            <span className="cnt-online">{activeDeptUsers}</span>
            <span className="cnt-sep">/</span>
            <span className="cnt-total">{totalDeptUsers}</span>
          </span>
        </div>

        {isExpanded && (
          <div className="tree-dept-children">
            {/* Child Departments / Directorates / Divisions */}
            {dept.subDepartments?.map((sub) => renderDepartment(sub, depth + 1))}

            {/* Employees in this department */}
            {dept.employees && dept.employees.length > 0 && (
              <div className="tree-dept-employees">
                {renderEmployees(dept.employees, depth)}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`org-tree-panel ${isCompact ? 'is-compact-mode' : ''}`}>
      {/* Top Header */}
      <div className="sub-panel-top-bar">
        <div className="sub-panel-dropdown-trigger" title="Контакты компании АО СК «Сентрас Иншуранс»">
          <span>Общие контакты</span>
          <span className="arrow-down">⌵</span>
        </div>

        <div className="tree-quick-actions">
          <button
            className={`tree-action-btn ${onlyOnline ? 'active' : ''}`}
            onClick={() => setOnlyOnline(!onlyOnline)}
            title={onlyOnline ? 'Показать всех сотрудников' : 'Показать только сотрудников в сети'}
          >
            🟢 {onlyOnline ? 'Все' : 'Онлайн'}
          </button>
          <button
            className="tree-action-btn"
            onClick={handleToggleExpandAll}
            title="Развернуть или свернуть все подразделения"
          >
            ↕️
          </button>
          <button
            className={`tree-action-btn ${isCompact ? 'active' : ''}`}
            onClick={() => setIsCompact(!isCompact)}
            title={isCompact ? 'Обычный режим' : 'Компактный режим (максимум информации)'}
          >
            {isCompact ? '📏' : '📐'}
          </button>
        </div>
      </div>

      {/* Search & Info Bar */}
      <div className="tree-search-wrapper">
        <div className="sub-panel-search-box">
          <input
            type="text"
            className="sub-panel-search-input"
            placeholder="Поиск по ФИО, должности или отделу..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <span className="search-clear-btn" onClick={() => setSearch('')} title="Очистить поиск">✕</span>
          ) : (
            <span className="search-icon">🔍</span>
          )}
        </div>
        <div className="tree-meta-stats">
          <span>{totalUsers} сотрудников</span>
          <span className="meta-sep">•</span>
          <span style={{ color: '#16a34a', fontWeight: 600 }}>{onlineUsers} в сети</span>
          {onlyOnline && <span className="meta-filter-active">(фильтр)</span>}
        </div>
      </div>

      {/* Hierarchical Tree Body with X and Y scroll */}
      <div className="org-tree-scrollable">
        {departments.length > 0 ? (
          departments.map((dept) => renderDepartment(dept, 0))
        ) : error ? (
          // Раньше здесь в любом случае висела «Загрузка…»: при отказе сервера
          // она не сменялась никогда, и понять, что произошло, было нельзя.
          <div style={{ padding: '24px', textAlign: 'center', fontSize: '13px' }}>
            <div style={{ fontSize: '28px', marginBottom: '10px' }}>⚠️</div>
            <div style={{ color: '#b91c1c', fontWeight: 600, marginBottom: '6px' }}>{error}</div>
            <div style={{ color: '#64748b', marginBottom: '14px', lineHeight: 1.6 }}>
              Структура компании не загрузилась. Переписка и уже открытые
              диалоги при этом работают.
            </div>
            {onRetry && (
              <button className="btn btn-secondary btn-sm" onClick={onRetry}>
                Повторить попытку
              </button>
            )}
          </div>
        ) : (
          <div style={{ padding: '24px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
            Загрузка оргструктуры...
          </div>
        )}
      </div>
    </div>
  );
}
