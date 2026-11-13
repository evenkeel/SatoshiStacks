(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksProfile = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';
  const fmt = (typeof module === 'object' && module.exports ? require('./amounts') : window.StacksAmounts).format;
  function metadata(previous, fields, claimName) {
    const profile = { ...previous, name:fields.name.trim(), display_name:fields.name.trim(), about:fields.about.trim(), picture:fields.picture.trim(), website:fields.website.trim() };
    if (claimName) profile.nip05 = `${claimName}@satoshistacks.com`;
    if (fields.lightningAddress !== undefined) {
      const address = fields.lightningAddress.trim().toLowerCase();
      if (address) {
        profile.satoshistacks_lightning_address = address;
        if (claimName) profile.lud16 = `${claimName}@satoshistacks.com`;
      } else {
        delete profile.satoshistacks_lightning_address;
        if (previous.satoshistacks_lightning_address && previous.lud16?.endsWith('@satoshistacks.com')) profile.lud16 = previous.satoshistacks_lightning_address;
      }
    }
    return profile;
  }
  function createEditor({session, getSigner, onSave, onFund, focus, restore}) {
    const $ = id => document.getElementById(id);
    let active = null;
    let fundingDraft = null;
    const status = message => { $('profileStatus').textContent = message; };
    function controls(disabled) {
      const data = active?.data, owned = !!data?.claimName, wants = $('profileClaimToggle').checked;
      const buying = wants && !owned;
      for (const key of ['name','about','picture','website']) $('profile'+key).disabled = disabled;
      $('profileClaimToggle').disabled = disabled || owned;
      $('profileClaimName').disabled = disabled || owned || !wants;
      $('profileClaimName').required = buying;
      $('profilelightningAddress').disabled = disabled || !wants;
      $('profilePurchaseConfirm').disabled = disabled || !buying;
      $('profilePurchaseConfirm').required = buying;
      $('profilePurchaseFields').hidden = !buying;
      $('profileClaimFields').hidden = !wants;
      $('profileSave').textContent = buying ? 'Buy username for ₿\u00a010,000 sats & save' : 'Save public profile';
      $('profileSave').disabled = disabled || (buying && (!data?.purchasesEnabled || data.availableSats < data.priceSats || !$('profilePurchaseConfirm').checked));
      $('profileFund').hidden = !buying || !data?.purchasesEnabled || data.availableSats >= data.priceSats;
      $('profileFund').disabled = disabled;
      $('profilePurchaseInfo').textContent = data ? `One-time price: ₿\u00a010,000 sats. Available account balance: ${fmt(data.availableSats)} sats.` : '';
      $('profilePurchaseAvailability').textContent = data && !data.purchasesEnabled ? 'Identifier purchases are temporarily unavailable. You can save your profile without buying a name.' : '';
    }
    function close({resume = true} = {}) {
      const state = active;
      active = null;
      state?.controller.abort();
      $('profileOverlay').classList.add('hidden');
      restore($('profileOverlay'));
      if (resume) state?.onDone?.();
    }
    async function api(state, body) {
      const response = await fetch('/api/profile', {method:body ? 'POST':'GET',signal:state.controller.signal,
        headers:{'x-session-token':state.session.token,'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)}:{})});
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Could not load profile.');
      return data;
    }
    async function open({signer = null, onDone} = {}) {
      if (active) return;
      const current = session();
      if (!current.token) return;
      const state = {session:current, signer, onDone, controller:new AbortController(), data:null};
      active = state;
      $('profileForm').reset();
      $('profileClaimName').disabled = true;
      $('profileClaimToggle').disabled = false;
      $('profileClaimFields').hidden = true;
      $('profileDone').textContent = signer ? 'Skip for now' : 'Done';
      $('profileSignerNote').textContent = 'Changes update your public Nostr profile.';
      $('profileOverlay').classList.remove('hidden');
      status('Loading your profile…'); controls(true); focus($('profileOverlay'));
      try {
        const data = await api(state);
        if (active !== state) return;
        state.data = data;
        const draft = fundingDraft?.pubkey === current.pubkey ? fundingDraft : null;
        for (const key of ['name','about','picture','website']) $('profile'+key).value = draft ? draft.fields[key] : (key === 'name' ? data.profile.display_name || data.profile.name : data.profile[key]) || '';
        $('profilelightningAddress').value = draft ? draft.fields.lightningAddress : data.forwardingAddress || '';
        if (data.claimName) {
          $('profileClaimToggle').checked = true;
          $('profileClaimToggle').disabled = true;
          $('profileClaimName').value = data.claimName;
          $('profileClaimName').disabled = true;
          $('profileClaimFields').hidden = false;
        } else if (draft?.claimName) {
          $('profileClaimToggle').checked = true;
          $('profileClaimName').value = draft.claimName;
        }
        status(data.claimName ? `Your identifier is ${data.claimName}@satoshistacks.com. Profile edits are free.` : 'Profile information is public. A custom identifier is optional and costs ₿\u00a010,000 sats once.');
        controls(false);
      } catch(error) { if (active === state) status(error.message); }
    }
    $('profileClaimToggle').addEventListener('change', () => controls(!!active?.busy || !active?.data));
    $('profilePurchaseConfirm').addEventListener('change', () => controls(!!active?.busy || !active?.data));
    $('profileFund').addEventListener('click', () => {
      const amount = Math.max(1,(active?.data?.priceSats || 10000)-(active?.data?.availableSats || 0));
      fundingDraft = {pubkey:active?.session.pubkey,claimName:$('profileClaimName').value,
        fields:Object.fromEntries(['name','about','picture','website','lightningAddress'].map(key=>[key,$('profile'+key).value]))};
      close({resume:false});onFund?.(amount);
    });
    $('profileDone').addEventListener('click', close);
    $('profileClose').addEventListener('click', close);
    $('profileForm').addEventListener('submit', async event => {
      event.preventDefault();
      const state = active;
      if (!state?.data || state.busy || session().token !== state.session.token) return;
      state.busy = true; controls(true);
      try {
        const signer = state.signer || getSigner();
        if (!signer) throw new Error('Import your saved nsec into a Nostr signer such as Sidecar, then sign in with that signer to edit your profile.');
        const claimName = $('profileClaimToggle').checked ? $('profileClaimName').value.trim().toLowerCase() : null;
        const buying = claimName && !state.data.claimName;
        if (buying && (!$('profilePurchaseConfirm').checked || !state.data.purchasesEnabled || state.data.availableSats < state.data.priceSats)) throw new Error('Add ₿\u00a010,000 sats to your account and confirm the username purchase first.');
        const fields = Object.fromEntries(['name','about','picture','website','lightningAddress'].map(key=>[key,$('profile'+key).value]));
        if (!claimName) fields.lightningAddress = '';
        const previous = {...state.data.profile};
        if (state.data.forwardingAddress) previous.satoshistacks_lightning_address = state.data.forwardingAddress;
        else delete previous.satoshistacks_lightning_address;
        const profile = metadata(previous, fields, claimName);
        status('Approve the profile update in your signer…');
        const pubkey = await window.StacksProviders.withTimeout(() => signer.getPublicKey(),{signal:state.controller.signal});
        if (pubkey !== state.session.pubkey) throw new Error('Your signer is using another account. Switch to the account you signed in with.');
        const signedEvent = await window.StacksProviders.withTimeout(() => signer.signEvent({kind:0,created_at:Math.max(Math.floor(Date.now()/1000),(state.data.event?.created_at || 0)+1),tags:[],content:JSON.stringify(profile)}),{signal:state.controller.signal});
        if (active !== state || session().token !== state.session.token) return;
        status('Saving and publishing your profile…');
        const data = await api(state,{signedEvent,previousEventId:state.data.event?.id || null,claimName,
          ...(buying ? {purchase:{confirmed:true,amountSats:state.data.priceSats}}:{})});
        if (active !== state || session().token !== state.session.token) return;
        state.data = data;
        fundingDraft = null;
        if (data.claimName) { $('profileClaimName').disabled = true; $('profileClaimToggle').disabled = true; }
        onSave(data.profile,data.availableSats);
        status(data.message);
        $('profileDone').textContent = state.signer ? 'Continue to table' : 'Done';
      } catch(error) { if (active === state) status(error.message || 'Could not save profile. Try again.'); }
      finally { if (active === state) { state.busy = false; controls(!state.data); } }
    });
    return {open,close};
  }
  return {metadata, createEditor};
});
