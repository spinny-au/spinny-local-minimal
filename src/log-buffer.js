const MAX = 500;
const lines = [];

function push(level, args) {
  const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  lines.push({ t: Date.now(), level, text });
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

export function getLines(n = 200) {
  return lines.slice(-n);
}

export function interceptConsole() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log   = (...a) => { push('log',   a); orig.log(...a);   };
  console.warn  = (...a) => { push('warn',  a); orig.warn(...a);  };
  console.error = (...a) => { push('error', a); orig.error(...a); };
}
