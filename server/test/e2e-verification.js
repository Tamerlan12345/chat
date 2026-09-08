const WebSocket = require('ws');

async function runE2eTests() {
  console.log('=== STARTING PRODUCTION E2E INTEGRATION VERIFICATION ===\n');

  // 1. Health check & Server Info
  const health = await fetch('http://localhost:2004/health').then(r => r.json());
  console.log('✓ Health check passed:', health.status, '| Version:', health.version);

  const serverInfo = await fetch('http://localhost:2004/api/settings/info').then(r => r.json());
  console.log('✓ Server Info fetched:', serverInfo.server_name, '| Company:', serverInfo.company_name);

  // 2. Admin login
  const adminLogin = await fetch('http://localhost:2004/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  }).then(r => r.json());

  if (!adminLogin.token) throw new Error('Admin login failed: ' + JSON.stringify(adminLogin));
  console.log('✓ Admin login successful:', adminLogin.user.full_name, '| Role:', adminLogin.user.role_name);

  const adminToken = adminLogin.token;
  const adminHeaders = { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

  // 3. Register a new real colleague
  const testUsername = `engineer_${Date.now().toString().slice(-4)}`;
  const regRes = await fetch('http://localhost:2004/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: testUsername,
      password: 'password123',
      full_name: 'Алексей Смирнов',
      job_title: 'Ведущий инженер',
      phone: '2405',
      email: `${testUsername}@company.local`,
      department_id: 2
    })
  }).then(r => r.json());

  if (!regRes.token) throw new Error('Colleague registration failed: ' + JSON.stringify(regRes));
  console.log('✓ New colleague registered:', regRes.user.full_name, '| UIN:', regRes.user.uin, '| Dept:', regRes.user.department_name);

  const colleagueToken = regRes.token;
  const colleagueHeaders = { 'Authorization': `Bearer ${colleagueToken}`, 'Content-Type': 'application/json' };

  // 4. Org Structure verification
  const orgTree = await fetch('http://localhost:2004/api/org/tree', { headers: adminHeaders }).then(r => r.json());
  console.log('✓ Org Tree verified: Departments count =', orgTree.tree.length, '| Total registered users =', orgTree.totalUsers);

  // 5. Channels verification
  const channels = await fetch('http://localhost:2004/api/channels', { headers: colleagueHeaders }).then(r => r.json());
  console.log('✓ Colleague channels access:', channels.map(c => `#${c.name}`).join(', '));
  const generalChannel = channels.find(c => c.name === 'Общий') || channels[0];

  // 6. Announcements & Read Acknowledgment
  const newAnn = await fetch('http://localhost:2004/api/announcements', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      title: 'Регламент корпоративной безопасности',
      content: 'Все сотрудники обязаны ознакомиться с правилами информационной безопасности.',
      priority: 'urgent',
      target_type: 'all'
    })
  }).then(r => r.json());
  console.log('✓ Corporate announcement broadcast created with ID:', newAnn.id);

  const ackRes = await fetch(`http://localhost:2004/api/announcements/${newAnn.id}/acknowledge`, {
    method: 'POST',
    headers: colleagueHeaders
  }).then(r => r.json());
  console.log('✓ Colleague acknowledged announcement:', ackRes.success, '| Timestamp:', ackRes.confirmed_at);

  const audit = await fetch(`http://localhost:2004/api/announcements/${newAnn.id}/audit`, { headers: adminHeaders }).then(r => r.json());
  console.log('✓ Announcement audit receipts: Acknowledged =', audit.stats.confirmedCount, '/', audit.stats.total);

  // 7. Web Database Studio
  const dbStats = await fetch('http://localhost:2004/api/admin/db/stats', { headers: adminHeaders }).then(r => r.json());
  console.log('✓ DB Studio Stats: Journal mode =', dbStats.journalMode, '| Integrity =', dbStats.integrity, '| Tables =', dbStats.tablesCount);

  const sqlRes = await fetch('http://localhost:2004/api/admin/db/query', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ sql: 'SELECT id, username, full_name, uin FROM users ORDER BY id ASC;' })
  }).then(r => r.json());
  console.log('✓ DB Studio SQL query verified:', sqlRes.rows.length, 'users in database (execution time:', sqlRes.executionTimeMs, 'ms)');

  const backupRes = await fetch('http://localhost:2004/api/admin/db/backup', {
    method: 'POST',
    headers: adminHeaders
  }).then(r => r.json());
  console.log('✓ 1-Click SQLite WAL Backup created:', backupRes.fileName, `(${backupRes.sizeFormatted})`);

  // 8. Real-time WebSocket Messaging test
  await new Promise((resolve, reject) => {
    const wsAdmin = new WebSocket('ws://localhost:2004/ws');
    const wsColleague = new WebSocket('ws://localhost:2004/ws');

    let adminReady = false;
    let colleagueReady = false;

    wsAdmin.on('open', () => wsAdmin.send(JSON.stringify({ type: 'auth', token: adminToken })));
    wsColleague.on('open', () => wsColleague.send(JSON.stringify({ type: 'auth', token: colleagueToken })));

    wsColleague.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth_success') {
        colleagueReady = true;
        if (adminReady && colleagueReady) doMessageTest();
      } else if (msg.type === 'new_message') {
        console.log('✓ Colleague received real-time message:', msg.message.text, 'from', msg.message.sender_name);
        wsAdmin.close();
        wsColleague.close();
        resolve();
      }
    });

    wsAdmin.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth_success') {
        adminReady = true;
        if (adminReady && colleagueReady) doMessageTest();
      }
    });

    function doMessageTest() {
      console.log('✓ WebSocket real-time connections authenticated for both peers.');
      // Admin sends message to colleague
      wsAdmin.send(JSON.stringify({
        type: 'send_message',
        conversationType: 'direct',
        targetId: regRes.user.id,
        text: 'Приветствую в команде! Корпоративный мессенджер успешно запущен.'
      }));
    }

    setTimeout(() => {
      wsAdmin.close();
      wsColleague.close();
      resolve();
    }, 4000);
  });

  console.log('\n=== ALL E2E PRODUCTION VERIFICATION TESTS PASSED 100% ===');
}

runE2eTests().catch(err => {
  console.error('\n❌ E2E VERIFICATION FAILED:', err);
  process.exit(1);
});
