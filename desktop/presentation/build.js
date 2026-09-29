// Собирает единый HTML: дек + встроенное приложение внутри.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'dist-deck');
const out = process.argv[2] || path.join(__dirname, '..', '..', 'docs', 'CentyChat-презентация.html');
let html = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'deck.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'deck.js'), 'utf8');
// Замена делается функцией: в коде встречаются $& и $', которые строковая
// замена истолковала бы как подстановку.
html = html
  .replace(/<link rel="stylesheet"[^>]*>/, () => '<style>' + css + '</style>')
  .replace(/<script type="module"[^>]*><\/script>/, () => '<script type="module">' + js.replace(/<\/script/gi, '<\/script') + '</script>');
fs.writeFileSync(out, html);
console.log('готово:', out, (fs.statSync(out).size / 1048576).toFixed(1), 'MB');
