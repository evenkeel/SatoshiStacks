/* Presentation only. Server state always renders immediately; motion never gates play. */
(function(root) {
  'use strict';
  const TIMING = Object.freeze({ deal:240, dealStagger:42, reveal:320, boardStagger:65, chips:340, payout:460 });
  function handKey(state) { return state?.handId || `${state?.tableId}:${state?.handCount}`; }
  function planTransition(previous, next) {
    const plan = { newHand:false, deal:[], board:[], reveal:[], bets:[], collect:[], winners:[] };
    // Joining/reconnecting restores the current position without replaying a hand.
    if (!previous || !next || previous.tableId !== next.tableId) return plan;
    plan.newHand = handKey(previous) !== handKey(next);
    if (plan.newHand) {
      if (next.handInProgress) {
        const seats = (next.players || []).map((p,i) => p?.holeCards?.length === 2 && !p.folded ? i : -1)
          .filter(i => i >= 0).sort((a,b) => ((a-next.dealerSeat-1+6)%6)-((b-next.dealerSeat-1+6)%6));
        for (let card=0;card<2;card++) for (const seat of seats) plan.deal.push({seat,card});
      }
      return plan;
    }
    const oldBoard = previous.communityCards || [], board = next.communityCards || [];
    if (oldBoard.every((card,i) => board[i] === card)) {
      for (let i=oldBoard.length;i<board.length;i++) plan.board.push(i);
    }
    const settled = previous.handInProgress && !next.handInProgress;
    for (let seat=0;seat<(next.players || []).length;seat++) {
      const p = next.players[seat], before = previous.players?.[seat];
      if (!p || !before || p.userId !== before.userId) continue;
      if (p.holeCards?.some((card,i) => card !== '??' && before.holeCards?.[i] === '??') && !p.folded) plan.reveal.push(seat);
      if (settled && p.wonPot) plan.winners.push({seat,amount:Math.max(0,p.stack-before.stack)});
      if (!settled && p.currentBet > before.currentBet) plan.bets.push({seat,amount:p.currentBet-before.currentBet});
      if (before.currentBet > 0 && p.currentBet < before.currentBet && (settled || next.pot > previous.pot)) {
        plan.collect.push({seat,amount:before.currentBet-p.currentBet});
      }
    }
    return plan;
  }

  function create({table, seatElement, betElement, cardElement = seatElement, cardHTML, chipHTML, media = root.matchMedia?.('(prefers-reduced-motion: reduce)')}) {
    const running = new Set(), transient = new Set();
    let layer;
    const enabled = () => !media?.matches && !root.document.hidden && typeof table.animate === 'function';
    function cancel() {
      for (const animation of running) animation.cancel();
      running.clear();
      for (const element of transient) element.remove();
      transient.clear();
    }
    function animate(element, frames, options, cleanup = () => {}) {
      const animation = element.animate(frames, {easing:'cubic-bezier(.22,.68,.25,1)',...options});
      running.add(animation);
      const done = () => { running.delete(animation); cleanup(); };
      animation.finished.then(done,done);
      return animation;
    }
    function center(element) {
      if (!element) return null;
      const r = element.getBoundingClientRect(), base = table.getBoundingClientRect();
      const sx = base.width / table.offsetWidth || 1, sy = base.height / table.offsetHeight || 1;
      return {x:(r.left+r.width/2-base.left)/sx-table.clientLeft,
        y:(r.top+r.height/2-base.top)/sy-table.clientTop, width:r.width/sx,height:r.height/sy};
    }
    function capture() {
      return {seats:Array.from({length:6},(_,i)=>center(seatElement(i))),
        bets:Array.from({length:6},(_,i)=>center(betElement(i))), pot:center(table.querySelector('#tablePotChips')),
        potChipCount:table.querySelector('#tablePotChips .pot-chip-pile')?.children.length || 0};
    }
    function own(element) { transient.add(element); return element; }
    function remove(element) { transient.delete(element); element.remove(); }
    function fly({html,from,to,width=34,height=30,delay=0,duration=TIMING.chips,kind='chips'}) {
      if (!from || !to) return;
      if (!layer) {
        layer = root.document.createElement('div');
        layer.className = 'table-motion-layer';
        layer.setAttribute('aria-hidden','true');
        table.appendChild(layer);
      }
      const packet = own(root.document.createElement('div'));
      packet.className = `table-motion-packet motion-${kind}`;
      packet.style.width = `${width}px`; packet.style.height = `${height}px`;
      packet.innerHTML = html;
      layer.appendChild(packet);
      const transform = (x,y,scale,angle=0) => `translate3d(${x-width/2}px,${y-height/2}px,0) rotate(${angle}deg) scale(${scale})`;
      animate(packet,[
        {transform:transform(from.x,from.y,.96,-3),opacity:0},
        {offset:.12,opacity:1},
        {offset:.6,transform:transform(from.x+(to.x-from.x)*.67,from.y+(to.y-from.y)*.67-8,1,1),opacity:1},
        {transform:transform(to.x,to.y,kind==='card'?1:.87),opacity:0}
      ],{duration,delay,fill:'both'},()=>remove(packet));
    }
    function reveal(wrapper, delay=0) {
      const front = wrapper?.querySelector('.card');
      if (!front) return;
      const back = own(root.document.createElement('div'));
      back.className = 'motion-card-back'; back.setAttribute('aria-hidden','true');
      back.innerHTML = cardHTML(null);
      wrapper.appendChild(back);
      animate(back,[{transform:'rotateY(0deg)',opacity:1},{transform:'rotateY(-90deg)',opacity:1}],
        {duration:TIMING.reveal*.45,delay,fill:'both'},()=>remove(back));
      animate(front,[{transform:'rotateY(90deg)',opacity:0},{transform:'rotateY(0deg)',opacity:1}],
        {duration:TIMING.reveal*.55,delay:delay+TIMING.reveal*.45,fill:'backwards'});
    }
    function play(previous,next,before) {
      const plan = planTransition(previous,next);
      if (plan.newHand) cancel();
      if (!enabled()) { cancel(); return; }
      const after = capture();
      const pot = after.pot || {x:table.clientWidth/2,y:table.clientHeight*.22};
      const dealer = center(table.querySelector('#dealerTray')) || {x:table.clientWidth/2,y:table.clientHeight*.2};
      for (const [i,{seat,card}] of plan.deal.entries()) {
        const destination = cardElement(seat)?.querySelectorAll('.np-cards > .card')[card];
        if (!destination) continue;
        const end = center(destination), delay = i*TIMING.dealStagger;
        fly({html:cardHTML(null,'small'),from:dealer,to:end,width:end.width,height:end.height,
          delay,duration:TIMING.deal,kind:'card'});
        animate(destination,[{opacity:0,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],
          {delay:delay+TIMING.deal*.8,duration:100,fill:'backwards'});
      }
      for (const [i,index] of plan.board.entries()) reveal(table.querySelector('#communityCards')?.children[index], i*TIMING.boardStagger);
      for (const seat of plan.reveal) {
        const cards = cardElement(seat)?.querySelector('.np-cards');
        if (cards) {
          // Preserve the server's revealed artwork; only animate its presentation.
          for (const [i,front] of [...cards.children].entries()) {
            if (!front.classList.contains('card')) continue;
            animate(front,[{transform:'perspective(600px) rotateY(80deg)',opacity:.15},{transform:'perspective(600px) rotateY(0deg)',opacity:1}],
              {duration:TIMING.reveal,delay:i*45});
          }
        }
      }
      for (const {seat,amount} of plan.bets) fly({html:chipHTML(amount),from:before?.seats[seat],to:after.bets[seat],delay:0});
      const potChips = table.querySelector('#tablePotChips .pot-chip-pile');
      const additions = [...(potChips?.children || [])].slice(before?.potChipCount || 0);
      for (const [i,{seat,amount}] of plan.collect.entries()) {
        const landing = additions[Math.floor(i * additions.length / plan.collect.length)];
        fly({html:chipHTML(amount),from:before?.bets[seat],to:center(landing) || pot,duration:280});
      }
      const payoutDelay = plan.collect.length ? 210 : 70;
      for (const [i,{seat,amount}] of plan.winners.entries()) {
        for (let packet=0;packet<3;packet++) fly({html:chipHTML(Math.max(1,Math.floor(amount/3))),from:before?.pot || pot,
          to:after.seats[seat],delay:payoutDelay+i*45+packet*38,duration:TIMING.payout});
        const nameplate = seatElement(seat);
        if (nameplate) animate(nameplate,[{boxShadow:'0 0 0 0 #d7bc8200'},
          {offset:.4,boxShadow:'0 0 0 3px #d7bc8240, 0 0 22px #d7bc8220'},
          {boxShadow:'0 0 0 0 #d7bc8200'}],{delay:payoutDelay+TIMING.payout*.6,duration:600});
      }
    }
    const onVisibility = () => { if (root.document.hidden) cancel(); };
    media?.addEventListener?.('change',cancel);
    root.addEventListener?.('resize',cancel);
    root.document.addEventListener('visibilitychange',onVisibility);
    return {capture,play,cancel,destroy() {
      cancel(); layer?.remove();
      media?.removeEventListener?.('change',cancel);
      root.removeEventListener?.('resize',cancel);
      root.document.removeEventListener('visibilitychange',onVisibility);
    }};
  }
  const api = { TIMING, planTransition, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StacksTableMotion = api;
})(typeof window !== 'undefined' ? window : globalThis);
