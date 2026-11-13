/* Presentation follows the viewport, never the device or authenticated session. */
(() => {
  'use strict';
  const compact = matchMedia('(max-width: 900px), (max-height: 500px)');
  const actions = document.getElementById('tableActionsBar');
  const dealer = document.getElementById('dealerStation');
  const dealerHome = document.createComment('Dealer desktop position');
  dealer.before(dealerHome);
  const account = document.querySelector('.account-bar nav');
  const actionsHome = document.createComment('Table actions desktop position');
  const accountHome = document.createComment('Account desktop position');
  actions.before(actionsHome);
  account.before(accountHome);
  function update() {
    const mobile = compact.matches;
    document.body.classList.toggle('is-mobile', mobile);
    if (mobile) {
      document.body.append(dealer);
      document.getElementById('mobileSeatActions').append(actions);
      document.getElementById('mobileAccountActions').append(account);
    } else {
      dealerHome.after(dealer);
      actionsHome.after(actions);
      accountHome.after(account);
    }
    window.dispatchEvent(new Event('table-layout-change'));
  }
  compact.addEventListener('change', update);
  update();
})();
