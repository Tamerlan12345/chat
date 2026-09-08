---
date: 2026-09-01
tags:
  - home
aliases:
  - Dashboard
---

# 🧠 loop start's Builder Vault

> Claude automatically saves everything important from every conversation.

---

## ⚡ Quick Navigation

[[Boards/Engineering\|📋 Engineering]]

[[index|📚 Каталог]] · [[Daily/|📁 Daily]] · [[Projects/|📁 Projects]] · [[Dev Logs/|📁 Dev Logs]] · [[Architecture/|📁 Architecture]] · [[Debugging/|📁 Debugging]] · [[Knowledge/|📁 Knowledge]] · [[Tasks/|📁 Tasks]] · [[Ideas/|📁 Ideas]]

---

## 📅 Recent Daily Notes

```dataview
TABLE WITHOUT ID file.link AS "Day", mood AS "Mood", energy AS "Energy"
FROM "Daily"
SORT date DESC
LIMIT 7
```

---

## 📊 Vault Stats

```dataviewjs
const all = dv.pages("");
dv.paragraph(`📝 **${all.length}** total notes`);
```
