const config = require('../config');
const SettingsService = require('./settings.service');

// Two independent layers, deliberately with different trust models:
//
// 1. ALLOWLIST (config.ALLOWED_CLIENT_IPS) — deploy-time only, set via
//    container env, never touched by the app itself. If configured, only
//    these IPs/CIDRs may reach the server at all. This is what stops
//    someone who got a copy of the installer from logging in with valid
//    (or guessed) credentials from a personal computer outside the office.
// 2. BLACKLIST (server_settings.ip_blacklist) — runtime, admin-controlled
//    from the Admin Console, for kicking one specific bad actor without a
//    redeploy. Always enforced, even when no allowlist is configured.
//
// A compromised admin account can widen nothing here: it can only ever add
// to the blacklist, never touch the allowlist.

function normalizeIp(raw) {
  if (!raw) return '';
  // Strips an IPv4-mapped IPv6 prefix like "::ffff:127.0.0.1" -> "127.0.0.1".
  // Same simplification already used elsewhere in this codebase (rate
  // limiter keys, /auth/knock ip_address) — a real IPv6 address without an
  // embedded IPv4 tail gets mangled too, but that fails CLOSED (won't match
  // any configured allowlist entry), never open.
  return raw.replace(/^.*:/, '');
}

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function matchesEntry(ip, entry) {
  entry = entry.trim();
  if (!entry) return false;
  if (entry.includes('/')) {
    const [range, bitsStr] = entry.split('/');
    const bits = parseInt(bitsStr, 10);
    if (Number.isNaN(bits) || bits < 0 || bits > 32) return false;
    const ipInt = ipToInt(ip);
    const rangeInt = ipToInt(range);
    if (ipInt === null || rangeInt === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) === (rangeInt & mask);
  }
  return ip === entry.trim();
}

function matchesAny(ip, list) {
  return list.some((entry) => matchesEntry(ip, entry));
}

// Resolves the real client IP for a request/upgrade, honoring
// X-Forwarded-For ONLY when the immediate TCP peer is a configured trusted
// proxy. Anyone hitting the app directly (bypassing that proxy) has their
// own forged X-Forwarded-For ignored — their raw socket IP is used instead.
function getClientIp(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress);
  if (config.TRUSTED_PROXY_IPS.length > 0 && matchesAny(socketIp, config.TRUSTED_PROXY_IPS)) {
    const xff = req.headers?.['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
  }
  return socketIp;
}

function isIpAllowed(ip) {
  const blacklist = (SettingsService.getSetting('ip_blacklist', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (matchesAny(ip, blacklist)) return false;

  if (config.ALLOWED_CLIENT_IPS.length === 0) return true; // not configured = open
  return matchesAny(ip, config.ALLOWED_CLIENT_IPS);
}

module.exports = { normalizeIp, getClientIp, isIpAllowed, matchesAny };
