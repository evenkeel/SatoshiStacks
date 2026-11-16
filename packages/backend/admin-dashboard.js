/* Admin dashboard behaviour. Served as a file because the site's Content
   Security Policy blocks inline scripts and inline event handlers. */
    let authToken = null;

    // Authentication
    async function authenticate() {
      const password = document.getElementById('adminPassword').value;
      // Verify token against server
      try {
        const res = await fetch('/api/admin/players', {
          headers: { 'X-Admin-Token': password }
        });
        if (res.ok) {
          authToken = password;
          document.getElementById('authOverlay').style.display = 'none';
          document.getElementById('dashboard').style.display = 'block';
          loadDashboard();
        } else {
          document.getElementById('authError').textContent = 'Incorrect password';
        }
      } catch (e) {
        document.getElementById('authError').textContent = 'Server connection error';
      }
    }

    // Authenticated fetch helper — adds admin token to all requests
    function adminFetch(url, options = {}) {
      options.headers = { ...options.headers, 'X-Admin-Token': authToken };
      return fetch(url, options);
    }

    // HTML escape helper — prevents XSS from user-controlled DB values
    // Quotes are escaped too: values are also written inside attributes.
    function esc(str) {
      if (str == null) return '';
      return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    // Tab switching
    function switchTab(tabName, evt) {
      // Remove active class from all tabs and content
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      // Add active class to clicked tab and corresponding content
      if (evt && evt.target) {
        evt.target.classList.add('active');
      } else {
        // Programmatic call: activate the tab that owns this panel.
        document.querySelectorAll('.tab').forEach(t => { if (t.dataset.tab === tabName) t.classList.add('active'); });
      }
      document.getElementById(tabName).classList.add('active');
      
      // Load data for the tab
      if (tabName === 'players') loadPlayers();
      if (tabName === 'ipbans') loadIpBans();
      if (tabName === 'abuse') loadAbuseLog();
      if (tabName === 'tables') loadActiveTables();
    }

    // Load dashboard
    async function loadDashboard() {
      loadOverview();
      loadPlayers();
    }

    // Load overview stats
    async function loadOverview() {
      try {
        const statsResp = await fetch('/api/stats').then(r => r.json());
        const stats = statsResp.stats || statsResp; // Unwrap { success, stats } envelope
        document.getElementById('totalPlayers').textContent = stats.totalPlayers || 0;
        document.getElementById('totalHands').textContent = stats.totalHands || 0;
        
        // Load players to count active/banned
        const players = await adminFetch('/api/admin/players').then(r => r.json());
        const activePlayers = players.filter(p => !p.banned).length;
        const bannedPlayers = players.filter(p => p.banned).length;
        
        document.getElementById('activePlayers').textContent = activePlayers;
        document.getElementById('bannedPlayers').textContent = bannedPlayers;
        
        // Recent activity
        const abuseLog = await adminFetch('/api/admin/abuse-log?limit=5').then(r => r.json());
        const activityEl = document.getElementById('recentActivity');
        
        if (abuseLog.length === 0) {
          activityEl.innerHTML = '<div class="empty-state">No recent activity</div>';
        } else {
          activityEl.innerHTML = abuseLog.map(entry => `
            <div class="log-entry ${esc(entry.action_type)}">
              <div class="log-time">${new Date(entry.timestamp * 1000).toLocaleString()}</div>
              <div><strong>${esc(entry.action_type)}</strong>: ${esc(entry.user_id) || 'N/A'}</div>
            </div>
          `).join('');
        }
      } catch (error) {
        console.error('Error loading overview:', error);
      }
    }

    // Load players
    async function loadPlayers() {
      try {
        const players = await adminFetch('/api/admin/players').then(r => r.json());
        const tbody = document.getElementById('playersTable');
        
        if (players.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No players yet</td></tr>';
          return;
        }
        
        // Fetch abuse log ONCE to extract player IPs (avoids N+1)
        const playerIps = {};
        try {
          const allLogs = await adminFetch('/api/admin/abuse-log?limit=1000').then(r => r.json());
          for (const log of allLogs) {
            if (log.user_id && log.ip_address && !playerIps[log.user_id]) {
              playerIps[log.user_id] = log.ip_address;
            }
          }
        } catch (e) {
          console.error('Error fetching abuse log for IPs:', e);
        }
        
        tbody.innerHTML = players.map(p => {
          const winRate = p.hands_played > 0 ? ((p.hands_won / p.hands_played) * 100).toFixed(1) : '0.0';
          const status = p.banned ? '<span class="badge badge-banned">Banned</span>' : '<span class="badge badge-active">Active</span>';
          const actionBtn = p.banned
            ? `<button class="btn btn-unban" data-action="unban" data-userid="${esc(p.user_id)}">Unban</button>`
            : `<button class="btn btn-ban" data-action="ban" data-userid="${esc(p.user_id)}">Ban (+IP)</button>`;
          
          const playerIp = playerIps[p.user_id] || 'Unknown';
          
          return `
            <tr>
              <td><code>${esc(p.user_id.substring(0, 8))}...</code></td>
              <td><strong>${esc(p.username)}</strong></td>
              <td><code style="font-size: 11px;">${esc(playerIp)}</code></td>
              <td>${Number(p.hands_played) || 0}</td>
              <td>${Number(p.hands_won) || 0}</td>
              <td>${esc(winRate)}%</td>
              <td>${status}</td>
              <td>
                ${actionBtn}
                <button class="btn btn-view" data-action="view-hands" data-userid="${esc(p.user_id)}">View Hands</button>
              </td>
            </tr>
          `;
        }).join('');
      } catch (error) {
        console.error('Error loading players:', error);
      }
    }

    // Ban player
    async function banPlayer(userId) {
      if (!confirm('Are you sure you want to ban this player?')) return;
      
      try {
        await adminFetch('/api/admin/ban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, reason: 'Admin action' })
        });
        
        alert('Player banned successfully');
        loadPlayers();
        loadOverview();
      } catch (error) {
        alert('Error banning player: ' + error.message);
      }
    }

    // Unban player
    async function unbanPlayer(userId) {
      if (!confirm('Are you sure you want to unban this player?')) return;
      
      try {
        await adminFetch('/api/admin/unban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId })
        });
        
        alert('Player unbanned successfully');
        loadPlayers();
        loadOverview();
      } catch (error) {
        alert('Error unbanning player: ' + error.message);
      }
    }

    // Load IP bans
    async function loadIpBans() {
      try {
        const bans = await adminFetch('/api/admin/ip-bans').then(r => r.json());
        const tbody = document.getElementById('ipBansTable');
        
        if (bans.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No IP addresses banned</td></tr>';
          return;
        }
        
        tbody.innerHTML = bans.map(ban => {
          const bannedDate = new Date(ban.banned_at * 1000).toLocaleString();
          
          return `
            <tr>
              <td><code>${esc(ban.ip_address)}</code></td>
              <td>${esc(bannedDate)}</td>
              <td>${esc(ban.reason || 'No reason provided')}</td>
              <td>${esc(ban.banned_by || 'System')}</td>
              <td>
                <button class="btn btn-unban" data-action="unban-ip" data-ip="${esc(ban.ip_address)}">Unban</button>
              </td>
            </tr>
          `;
        }).join('');
      } catch (error) {
        console.error('Error loading IP bans:', error);
      }
    }

    // Ban IP manually
    async function banIpManual() {
      const ipAddress = document.getElementById('ipBanInput').value.trim();
      const reason = document.getElementById('ipBanReason').value.trim();
      
      if (!ipAddress) {
        alert('Please enter an IP address');
        return;
      }
      
      if (!reason) {
        alert('Please enter a reason for the ban');
        return;
      }
      
      try {
        await adminFetch('/api/admin/ban-ip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ipAddress, reason })
        });
        
        alert(`IP ${ipAddress} banned successfully`);
        document.getElementById('ipBanInput').value = '';
        document.getElementById('ipBanReason').value = '';
        loadIpBans();
        loadOverview();
      } catch (error) {
        alert('Error banning IP: ' + error.message);
      }
    }

    // Unban IP
    async function unbanIpFunction(ipAddress) {
      if (!confirm(`Are you sure you want to unban IP ${ipAddress}?`)) return;
      
      try {
        await adminFetch('/api/admin/unban-ip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ipAddress })
        });
        
        alert(`IP ${ipAddress} unbanned successfully`);
        loadIpBans();
        loadOverview();
      } catch (error) {
        alert('Error unbanning IP: ' + error.message);
      }
    }

    // Load abuse log
    async function loadAbuseLog() {
      try {
        const logs = await adminFetch('/api/admin/abuse-log?limit=50').then(r => r.json());
        const logEl = document.getElementById('abuseLog');
        
        if (logs.length === 0) {
          logEl.innerHTML = '<div class="empty-state">No abuse events logged</div>';
          return;
        }
        
        logEl.innerHTML = logs.map(entry => `
          <div class="log-entry ${esc(entry.action_type)}">
            <div class="log-time">${new Date(entry.timestamp * 1000).toLocaleString()}</div>
            <div>
              <strong>${esc(entry.action_type)}</strong>:
              User ${entry.user_id ? esc(entry.user_id.substring(0, 8)) + '...' : 'N/A'}
              ${entry.ip_address ? ' (IP: ' + esc(entry.ip_address) + ')' : ''}
            </div>
          </div>
        `).join('');
      } catch (error) {
        console.error('Error loading abuse log:', error);
      }
    }

    // Load active tables
    async function loadActiveTables() {
      try {
        const tables = await adminFetch('/api/admin/tables').then(r => r.json());
        const tablesEl = document.getElementById('activeTables');
        
        if (!tables || tables.length === 0) {
          tablesEl.innerHTML = '<div class="empty-state">No active tables</div>';
          return;
        }
        
        tablesEl.innerHTML = tables.map(table => `
          <div class="card">
            <h3>Table ${esc(table.id)}</h3>
            <p><strong>Players:</strong> ${(table.players || []).length}/6</p>
            <p><strong>Hand in progress:</strong> ${table.handInProgress ? 'Yes' : 'No'}</p>
            <p><strong>Players:</strong> ${(table.players || []).map(p => esc(p.username)).join(', ')}</p>
          </div>
        `).join('');
      } catch (error) {
        console.error('Error loading tables:', error);
        document.getElementById('activeTables').innerHTML = '<div class="empty-state">Error loading tables</div>';
      }
    }

    // Search hands
    async function searchHands() {
      const userId = document.getElementById('handSearch').value.trim();
      if (!userId) {
        alert('Please enter a hand ID or player ID');
        return;
      }
      
      try {
        const byHand = document.getElementById('handSearchType').value === 'hand';
        const response = byHand ? await adminFetch(`/api/admin/hand/${encodeURIComponent(userId)}`) : await fetch(`/api/hands/${encodeURIComponent(userId)}`);
        const resp = await response.json();
        if (!response.ok) throw new Error(resp.error || 'History lookup failed');
        const hands = byHand ? (resp.hand ? [resp.hand] : []) : (resp.hands || []); // Unwrap { success, hands } envelope
        const historyEl = document.getElementById('handHistory');

        if (!hands || hands.length === 0) {
          historyEl.innerHTML = '<div class="empty-state">No matching hand history found</div>';
          return;
        }

        historyEl.innerHTML = hands.map(hand => `
          <div class="card">
            <h3>Hand #${esc(hand.hand_id)}</h3>
            <div class="hand-history">${esc(hand.hand_history)}</div>
            ${hand.players ? `<details><summary>Private cards and player records</summary><pre>${esc(JSON.stringify(hand.players,null,2))}</pre></details>` : ''}
            ${hand.events ? `<details><summary>Timestamped audit events</summary><pre>${esc(JSON.stringify(hand.events,null,2))}</pre></details>` : ''}
          </div>
        `).join('');
      } catch (error) {
        alert('Error loading hands: ' + error.message);
      }
    }

    // View player hands
    function viewPlayerHands(userId) {
      switchTab('hands'); // Programmatic call — no event, finds the tab by its data-tab
      document.getElementById('handSearchType').value = 'player';
      document.getElementById('handSearch').value = userId;
      searchHands();
    }

    // Search players
    function searchPlayers() {
      const query = document.getElementById('playerSearch').value.toLowerCase();
      const rows = document.querySelectorAll('#playersTable tr');
      
      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(query) ? '' : 'none';
      });
    }

    // Refresh all
    function refreshAll() {
      loadOverview();
      loadPlayers();
      loadAbuseLog();
      loadActiveTables();
    }

    // Delegated click handler for dynamic admin buttons (avoids inline onclick XSS risk)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'login') authenticate();
      else if (action === 'refresh-all') refreshAll();
      else if (action === 'tab') switchTab(btn.dataset.tab, { target: btn });
      else if (action === 'search-players') searchPlayers();
      else if (action === 'ban-ip') banIpManual();
      else if (action === 'search-hands') searchHands();
      else if (action === 'ban') banPlayer(btn.dataset.userid);
      else if (action === 'unban') unbanPlayer(btn.dataset.userid);
      else if (action === 'view-hands') viewPlayerHands(btn.dataset.userid);
      else if (action === 'unban-ip') unbanIpFunction(btn.dataset.ip);
    });

    // Auto-refresh every 30 seconds
    setInterval(() => {
      if (authToken) {
        loadOverview();
      }
    }, 30000);
  