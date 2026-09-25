(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  if(root) root.AdminMfa = api;
})(typeof window !== 'undefined' ? window : null, function(){
  'use strict';

  function verifiedTotpFactors(result){
    const totp = result && result.data && Array.isArray(result.data.totp) ? result.data.totp : [];
    return totp.filter(f => f && f.id && f.status === 'verified');
  }

  function normalizeTotpCode(value){
    return String(value || '').replace(/\D/g, '').slice(0, 6);
  }

  function decideRoute(currentLevel, factors){
    const count = Array.isArray(factors) ? factors.length : 0;
    if(count === 0) return 'enroll_primary';
    if(currentLevel !== 'aal2') return 'challenge';
    if(count < 2) return 'enroll_backup';
    return 'app';
  }

  return { verifiedTotpFactors, normalizeTotpCode, decideRoute };
});
