const koffi = require('koffi');
const u = koffi.load('kernel32.dll');
const a = koffi.load('advapi32.dll');
const OP = u.func('void* OpenProcess(uint32 access, int inherit, uint32 pid)');
const OPT = a.func('int OpenProcessToken(void* proc, uint32 access, _Out_ void** tok)');
const GTI = a.func('int GetTokenInformation(void* tok, int cls, void* info, uint32 len, _Out_ uint32* ret)');
const CP = u.func('uint32 GetCurrentProcessId()');
function isElevated(pid) {
  const h = OP(0x1000 /*QUERY_LIMITED_INFORMATION*/, 0, pid); // 0x1000
  if (!h) return 'OpenProcess失败 err=' + (u.func('uint32 GetLastError()')());
  const tok = [null];
  if (!OPT(h, 0x0008 /*TOKEN_QUERY*/, tok)) { return 'OpenProcessToken失败'; }
  const info = Buffer.alloc(4);
  const ret = Buffer.alloc(4);
  const ok = GTI(tok[0], 23 /*TokenElevation*/, info, 4, ret);
  if (!ok) return 'GetTokenInformation失败 err=' + (u.func('uint32 GetLastError()')());
  return info.readUInt32LE(0) === 1 ? 'ELEVATED(高完整性)' : 'medium(标准)';
}
console.log('自己 pid=' + CP() + ' → ' + isElevated(CP()));
for (const pid of [19136, 21332, 31564, 8304, 35552]) {
  console.log('pid=' + pid + ' → ' + isElevated(pid));
}
