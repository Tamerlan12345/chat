---
type: index
date: 2026-09-07
tags:
  - index
  - meta
ai-first: true
---

# Каталог vault

## For future agent
Главный индекс базы знаний OpenMyChat. Актуализирован на 2026-09-07 после перевода системы в чистый продакшн (строго чат коллег, без канбана/BBS, без заглушек, со сборщиком electron-builder).

## Навигация
- [[Home]] — дашборд vault: очереди, свежие заметки, ссылки на доски.
- [[_CLAUDE]] — как здесь работать и где проходит граница с циклом.
- [[log]] — указатель на журнал операций.
- [[Tasks/Tasks]] — реестр задач проекта.

## Проекты
- [[Projects/MyChat Analog]] — устав проекта OpenMyChat Enterprise.

## Архитектура
- [[Architecture/Architecture - Overview]] — общая архитектура, стек и диаграмма потоков данных.
- [[Architecture/Architecture - Database]] — схема БД SQLite WAL, таблицы, миграции и Web Studio.
- [[Architecture/Architecture - Realtime and WebRTC]] — протокол WebSocket, статусы присутствия, P2P звонки.
- [[Architecture/Architecture - Remote Desktop]] — плагин удаленного рабочего стола для ИТ-помощи.
- [[Architecture/Architecture - Server Deployment and Connection]] — жизненный цикл сервера, Windows Service, порты и алгоритм подключения.
- [[Architecture/Architecture - Telegram Integration Guide]] — варианты интеграции с Telegram (оповещения, шлюз, комплаенс АРРФР).
- [[Architecture/Architecture - MyChat Server Reference and Functional Map]]
- [[Architecture/Architecture - Zero-Touch Device Pairing and Hierarchical Contours]] — эталонный разбор вкладок, процессов и функциональной карты MyChat Server.
- [[Architecture/Architecture - Key decisions]] — архитектурные решения (ADR-001 — ADR-006).

## Журналы разработки (Logs)
- [[Logs/2026-09-07]] — продакшн-рефакторинг (удаление канбана, чистый чат, electron-builder).
- [[Logs/2026-09-04]] — начальная реализация ядра и прототипа.
- [[Logs/2026-09-01]] — развертывание vault-шаблона.
