const http = require('http');

async function trigger() {
  // 1. Login as ivanov
  const loginData = JSON.stringify({ username: 'ivanov', password: 'user123' });
  const req = http.request({
    hostname: 'localhost',
    port: 2004,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(loginData)
    }
  }, (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      const data = JSON.parse(raw);
      console.log('Logged in as Alexey, token:', data.token?.substring(0, 15));
      sendMessage(data.token);
    });
  });
  req.write(loginData);
  req.end();
}

function sendMessage(token) {
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://localhost:2004/ws');

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token }));

    setTimeout(() => {
      console.log('Sending instant direct message to admin (User 1)...');
      ws.send(JSON.stringify({
        type: 'send_message',
        conversationType: 'direct',
        targetId: 1,
        text: 'Алексей Смирнов: Отправил отчет по обновлению корпоративного сервера. Всплывающее уведомление работает!'
      }));

      setTimeout(() => {
        console.log('Message sent successfully!');
        ws.close();
        process.exit(0);
      }, 1000);
    }, 500);
  });
}

trigger().catch(console.error);
