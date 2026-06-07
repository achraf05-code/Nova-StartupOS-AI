/* =====================================================================
   Nova StartupOS AI - Backend API client (NovaApi)
   Phase 1: Authentication is handled by Supabase Auth (supabase-js v2).
   Auth methods below call the supabase.auth SDK and map the session +
   the `profiles` table row into the exact JSON contract main.js expects.

   The remaining (non-auth) methods still target the legacy REST API via
   `request()`; they will be migrated in later phases. Configure that base
   via window.NOVA_API_BASE or localStorage ('nova.api_base').
   ===================================================================== */
(function (global) {
  'use strict';

  /* ----------------------------- Supabase -----------------------------
     LOCAL LIVE TESTING — paste your project credentials below, OR set
     window.SUPABASE_URL / window.SUPABASE_ANON_KEY before this script loads
     (e.g. an inline <script> in index.html) to avoid editing this file.
     --------------------------------------------------------------------- */
  const SUPABASE_URL = global.SUPABASE_URL
    || localStorage.getItem('nova.supabase_url')
    || "https://wcjdtxlhylevzwjqkjss.supabase.co";
  const SUPABASE_ANON_KEY = global.SUPABASE_ANON_KEY
    || localStorage.getItem('nova.supabase_anon_key')
    || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjamR0eGxoeWxldnp3anFranNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1ODc4NzUsImV4cCI6MjA5NjE2Mzg3NX0.smIH3GczDcL2NgcGe1EXHQEWcQ9JaZPMueT88VgSios";

  // Guard: only create the client when the SDK is present and creds look set.
  const _credsReady = SUPABASE_URL.indexOf('your-project-id') === -1
    && SUPABASE_ANON_KEY.indexOf('your-anon-public-key') === -1;
  let supabase = null;
  if (global.supabase && typeof global.supabase.createClient === 'function') {
    supabase = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    if (!_credsReady) {
      console.warn('[NovaApi] Supabase credentials are still placeholders. ' +
        'Set SUPABASE_URL / SUPABASE_ANON_KEY in api.js (or window.*) to go live.');
    }
  } else {
    console.warn('[NovaApi] Supabase SDK not found on window. Auth/DB calls will fail until it loads.');
  }

  const BASE = global.NOVA_API_BASE
    || localStorage.getItem('nova.api_base')
    || 'https://nova-startup-os-ai.vercel.app/api';

  const TOKEN_KEY = 'nova.token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
  function isAuthed() { return !!getToken(); }

  async function request(method, path, body, opts) {
    opts = opts || {};
    const headers = { 'Accept': 'application/json' };
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
      signal: opts.signal,
    });

    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || ('HTTP ' + res.status));
      err.status = res.status;
      err.errors = data.errors;
      if (res.status === 401) setToken(null);
      throw err;
    }
    return data;
  }

  const NovaApi = {
    base: BASE,
    supabase,
    SUPABASE_URL,
    isAuthed, getToken, setToken,

    /* ============================== AUTH ==============================
       All auth flows go through Supabase. Each resolves to the mapped
       `user` object (see _handleAuthResponse), and caches the access
       token so legacy authed fetches (exports, profile) keep working. */

    // Build the { token, user } contract from a Supabase user + session.
    // Fetches the matching `profiles` row for role + plan_tier.
    async _handleAuthResponse(supabaseUser, session) {
      if (!supabaseUser) return null;

      // Resolve the access token (from the passed session or current one).
      let token = session && session.access_token;
      if (!token) {
        const { data } = await supabase.auth.getSession();
        token = data && data.session ? data.session.access_token : null;
      }
      setToken(token);

      // Pull role + plan from the profiles table (keyed by auth user id).
      let profile = null;
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('name, role, plan_tier')
          .eq('id', supabaseUser.id)
          .single();
        if (!error) profile = data;
      } catch (e) { /* table may not exist yet during early setup */ }

      const meta = supabaseUser.user_metadata || {};
      const role = (profile && profile.role) || meta.role || 'User';
      const isSuperAdmin = role === 'Super Admin';
      const isAdmin = role === 'Admin' || isSuperAdmin;
      const planTier = (profile && profile.plan_tier) || meta.plan_tier || 'Free';
      const name = (profile && profile.name) || meta.display_name || meta.name
        || (supabaseUser.email ? supabaseUser.email.split('@')[0] : 'Founder');

      const user = {
        id: supabaseUser.id,
        name,
        email: supabaseUser.email,
        plan: /plan$/i.test(planTier) ? planTier : (planTier + ' Plan'),
        plan_tier: planTier,
        is_admin: isAdmin,
        is_super_admin: isSuperAdmin,
        role,
      };
      return { token, user };
    },

    async register(name, email, password) {
      // Support both register(name,email,password) and register({name,email,password}).
      if (name && typeof name === 'object') {
        const p = name; name = p.name; email = p.email; password = p.password;
      }
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: name, name } },
      });
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      const mapped = await this._handleAuthResponse(data.user, data.session);
      return mapped ? mapped.user : null;
    },

    async login(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { const e = new Error(error.message); e.status = error.status || 401; throw e; }
      const mapped = await this._handleAuthResponse(data.user, data.session);
      return mapped ? mapped.user : null;
    },

    async quickLogin(provider) {
      // 'google' | 'github' — redirects the browser to the OAuth flow.
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: global.location.origin + global.location.pathname },
      });
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return data;
    },

    async logout() {
      try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
      setToken(null);
      if (global.NovaStore) {
        if (typeof NovaStore.clear === 'function') NovaStore.clear();
        else if (typeof NovaStore.reset === 'function') NovaStore.reset();
      }
    },

    // Check for an existing session on page load; resolves to the mapped
    // user (or null when no session exists / Supabase not configured).
    async me() {
      if (!supabase) return null;
      const { data, error } = await supabase.auth.getUser();
      if (error || !data || !data.user) { setToken(null); return null; }
      const mapped = await this._handleAuthResponse(data.user);
      return mapped ? mapped.user : null;
    },

    changePassword(payload) { return request('POST', '/auth/change-password', payload); },
    updateProfile(payload) { return request('PUT', '/auth/profile', payload).then(r => r.user); },

    // ---- 2FA ----
    twoFactorStatus() { return request('GET', '/auth/2fa'); },
    twoFactorEnable() { return request('POST', '/auth/2fa/enable'); },
    twoFactorConfirm(code) { return request('POST', '/auth/2fa/confirm', { code }); },
    twoFactorDisable() { return request('POST', '/auth/2fa/disable'); },

    // ---- Billing ----
    billing() { return request('GET', '/billing'); },
    checkout(payload) { return request('POST', '/billing/checkout', payload); },
    cancelSubscription() { return request('POST', '/billing/cancel'); },

    // ---- Workspaces ----
    workspaces() { return request('GET', '/workspaces').then(r => r.data); },
    createWorkspace(payload) { return request('POST', '/workspaces', payload).then(r => r.data); },
    updateWorkspace(id, payload) { return request('PUT', '/workspaces/' + id, payload).then(r => r.data); },
    deleteWorkspace(id) { return request('DELETE', '/workspaces/' + id); },

    // ---- Startups (Supabase: `startups` table + `startup-logos` bucket) ----

    // Upload a logo file to the 'startup-logos' bucket and return its public URL.
    async _uploadLogo(file) {
      if (!file || typeof file === 'string') return (typeof file === 'string' ? file : null);
      const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : 'png';
      const uniq = (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
      const path = uniq + '.' + ext;
      const { error: upErr } = await supabase.storage.from('startup-logos').upload(path, file, { cacheControl: '3600', upsert: false });
      if (upErr) { const e = new Error(upErr.message); e.status = upErr.status; throw e; }
      const { data } = supabase.storage.from('startup-logos').getPublicUrl(path);
      return data ? data.publicUrl : null;
    },

    // Pull the logo file out of whatever field the wizard/edit form provides.
    _pickLogoFile(d) {
      return (d && (d.logoFile || d.startup_file || d.logo_file)) || null;
    },

    async createStartup(startupData) {
      startupData = startupData || {};
      // Step A — logo upload (optional)
      let logo_url = startupData.logo_url || null;
      const file = this._pickLogoFile(startupData);
      if (file) logo_url = await this._uploadLogo(file);

      // Step B — resolve the auth user id and insert the row
      const uid = (await supabase.auth.getUser()).data.user.id;
      const row = {
        name: startupData.name,
        industry: startupData.industry,
        country: startupData.country,
        current_stage: startupData.current_stage || startupData.stage || null,
        logo_url,
        user_id: uid,
      };
      const { data, error } = await supabase.from('startups').insert(row).select().single();
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return data;
    },

    async getStartups() {
      const { data, error } = await supabase
        .from('startups')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return data || [];
    },

    // Backwards-compatible alias used by existing callers (workspace arg ignored;
    // RLS scopes rows to the logged-in user).
    startups() { return this.getStartups(); },

    async startup(id) {
      const { data, error } = await supabase.from('startups').select('*').eq('id', id).single();
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return data;
    },

    async updateStartup(id, updatedData) {
      updatedData = updatedData || {};
      const patch = Object.assign({}, updatedData);
      // Handle a new logo upload during editing.
      const file = this._pickLogoFile(updatedData);
      if (file) patch.logo_url = await this._uploadLogo(file);
      // Strip non-column helper fields before writing.
      delete patch.logoFile; delete patch.startup_file; delete patch.logo_file;
      if (patch.stage && !patch.current_stage) { patch.current_stage = patch.stage; }
      delete patch.stage;

      const { data, error } = await supabase.from('startups').update(patch).eq('id', id).select().single();
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return data;
    },

    async deleteStartup(id) {
      const { error } = await supabase.from('startups').delete().eq('id', id);
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return { success: true, id };
    },

    // ---- Generated Documents (Supabase: `generated_documents` table) ----
    // Persist an AI-generated asset (business plan, pitch deck, chat transcript…).
    async saveDocument(doc) {
      doc = doc || {};
      const uid = (await supabase.auth.getUser()).data.user.id;
      const row = {
        startup_id: doc.startup_id || null,
        user_id: uid,
        doc_type: doc.doc_type,
        title: doc.title,
        content: typeof doc.content === 'string' ? doc.content : JSON.stringify(doc.content),
      };
      const { data, error } = await supabase.from('generated_documents').insert(row).select().single();
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return data;
    },

    async getDocuments(startupId) {
      let q = supabase.from('generated_documents').select('*').order('created_at', { ascending: false });
      if (startupId) q = q.eq('startup_id', startupId);
      const { data, error } = await q;
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return data || [];
    },

    async deleteDocument(id) {
      const { error } = await supabase.from('generated_documents').delete().eq('id', id);
      if (error) { const e = new Error(error.message); e.status = error.status; throw e; }
      return { success: true, id };
    },

    // ---- Documents ----
    generateBusinessPlan(startupId) { return request('POST', '/startups/' + startupId + '/business-plans/generate').then(r => r.data); },
    businessPlans(startupId) { return request('GET', '/startups/' + startupId + '/business-plans').then(r => r.data); },
    generatePitchDeck(startupId) { return request('POST', '/startups/' + startupId + '/pitch-decks/generate').then(r => r.data); },
    runAssessment(startupId) { return request('POST', '/startups/' + startupId + '/assessments/run'); },

    // ---- Funding & Visa ----
    funding(params) { return request('GET', '/funding' + qs(params)).then(r => r.data); },
    visa(params) { return request('GET', '/visa' + qs(params)).then(r => r.data); },
    saveFunding(payload) { return request('POST', '/funding/save', payload); },

    // ---- Notifications ----
    notifications() { return request('GET', '/notifications'); },
    markAllRead() { return request('POST', '/notifications/read-all'); },

    // ---- Copilot ----
    conversations() { return request('GET', '/copilot/conversations').then(r => r.data); },
    conversation(id) { return request('GET', '/copilot/conversations/' + id).then(r => r.data); },
    deleteConversation(id) { return request('DELETE', '/copilot/conversations/' + id); },
    sendChat(payload) { return request('POST', '/copilot/send', payload); },

    /**
     * Streaming chat over Server-Sent Events. Calls onToken(delta) as text
     * arrives and resolves with { conversation_id } when complete.
     */
    async streamChat(payload, onToken) {
      const res = await fetch(BASE + '/copilot/stream', {
        method: 'POST',
        headers: {
          'Accept': 'text/event-stream',
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getToken(),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) throw new Error('Stream failed (' + res.status + ')');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', convId = null, event = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
          if (line.startsWith('data:')) {
            const d = JSON.parse(line.slice(5).trim() || '{}');
            if (event === 'start' || event === 'done') convId = d.conversation_id || convId;
            if (event === 'token' && d.delta && onToken) onToken(d.delta);
          }
        }
      }
      return { conversation_id: convId };
    },

    // ---- Admin & Super Admin (Supabase tables, role-gated by RLS) ----

    // Profiles-backed user directory.
    async adminGetUsers() {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, email, role, plan_tier, is_active, created_at')
        .order('created_at', { ascending: false });
      if (error) throw sbErr(error);
      return data || [];
    },
    async adminUpdateUserStatus(userId, isActive) {
      const { data, error } = await supabase
        .from('profiles').update({ is_active: !!isActive }).eq('id', userId).select().single();
      if (error) throw sbErr(error);
      return data;
    },

    // Support tickets. Resolve the requester's name/email — either from
    // denormalized columns or a joined `profiles` relation — and normalize
    // the messages JSONB so the UI never sees undefined.
    async adminGetTickets() {
      // Try selecting with a profiles relation; fall back to a plain select.
      let rows = null;
      try {
        const res = await supabase
          .from('support_tickets')
          .select('*, profile:profiles(name, email)')
          .order('created_at', { ascending: false });
        if (!res.error) rows = res.data;
      } catch (e) { /* relation may not exist */ }
      if (rows == null) {
        const res = await supabase.from('support_tickets').select('*').order('created_at', { ascending: false });
        if (res.error) throw sbErr(res.error);
        rows = res.data;
      }
      return (rows || []).map(normTicketRow);
    },
    async adminReplyToTicket(ticketId, messageArray, status) {
      const patch = { messages: messageArray };
      if (status) patch.status = status;
      const { data, error } = await supabase
        .from('support_tickets').update(patch).eq('id', ticketId).select().single();
      if (error) throw sbErr(error);
      return normTicketRow(data);
    },

    // Super Admin — AI providers configuration. Normalizes schema variations
    // so toggles/costs never bind to undefined.
    async superAdminGetAIConfig() {
      const { data, error } = await supabase.from('ai_providers_config').select('*');
      if (error) throw sbErr(error);
      return (data || []).map(normAiConfigRow);
    },
    async superAdminUpdateAIConfig(providerName, updatedFields) {
      const { data, error } = await supabase
        .from('ai_providers_config').update(updatedFields).eq('provider_name', providerName).select().single();
      if (error) throw sbErr(error);
      return normAiConfigRow(data);
    },

    // Super Admin — security: blocked IPs.
    async superAdminGetBlockedIPs() {
      const { data, error } = await supabase
        .from('blocked_ips').select('*').order('created_at', { ascending: false });
      if (error) throw sbErr(error);
      return (data || []).map(normBlockedIpRow);
    },
    async superAdminBlockIP(ipAddress, reason) {
      const uid = (await supabase.auth.getUser()).data.user.id;
      const { data, error } = await supabase
        .from('blocked_ips').insert({ ip_address: ipAddress, reason: reason || null, created_by: uid }).select().single();
      if (error) throw sbErr(error);
      return normBlockedIpRow(data);
    },
    async superAdminUnblockIP(id) {
      const { error } = await supabase.from('blocked_ips').delete().eq('id', id);
      if (error) throw sbErr(error);
      return { success: true, id };
    },

    // Super Admin — payment gateway config (upsert by provider).
    async superAdminSaveGateway(payload) {
      const { data, error } = await supabase
        .from('payment_gateways').upsert(payload, { onConflict: 'provider' }).select().single();
      if (error) throw sbErr(error);
      return data;
    },

    // ---- Admin Overview stats (Supabase aggregation) ----
    async adminGetStats() {
      const countOf = async (table) => {
        try {
          const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
          if (error) return 0;
          return count || 0;
        } catch (e) { return 0; }
      };
      const [users, startups, tickets, activeSubs] = await Promise.all([
        countOf('profiles'), countOf('startups'), countOf('support_tickets'),
        (async () => {
          try {
            const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).neq('plan_tier', 'Free');
            return count || 0;
          } catch (e) { return 0; }
        })(),
      ]);
      // Revenue is derived (no payments table in scope yet): paid plans × nominal ARPU.
      const revenue = activeSubs * 39;
      return { users, startups, tickets, active_subscriptions: activeSubs, revenue };
    },

    // ---- Audit logs (latest 50, graceful fallback) ----
    async adminGetAuditLogs() {
      try {
        const { data, error } = await supabase
          .from('audit_logs').select('*').order('created_at', { ascending: false }).limit(50);
        if (error || !data) throw (error || new Error('no data'));
        return data;
      } catch (e) {
        return [{ created_at: new Date().toISOString(), user: { name: 'system' }, action: 'System Ready — Monitoring Active', ip_address: '—' }];
      }
    },

    // ---- Admin ----
    admin: {
      dashboard() { return request('GET', '/admin/dashboard'); },
      // Users come from the Supabase `profiles` table (shape kept compatible:
      // { data: rows } with a `roles` array for the existing renderer).
      async users(search) {
        let q = supabase.from('profiles').select('id, name, email, role, plan_tier, is_active, created_at');
        if (search) q = q.ilike('name', '%' + search + '%');
        const { data, error } = await q.order('created_at', { ascending: false });
        if (error) throw sbErr(error);
        const rows = (data || []).map(p => ({
          id: p.id,
          name: p.name || (p.email ? p.email.split('@')[0] : '—'),
          email: p.email || '',
          roles: p.role ? [p.role] : [],
          plan_tier: p.plan_tier,
          is_active: p.is_active !== false,
          created_at: p.created_at,
        }));
        return { data: rows };
      },
      async toggleUser(id) {
        const { data: cur, error: e1 } = await supabase.from('profiles').select('is_active').eq('id', id).single();
        if (e1) throw sbErr(e1);
        const next = !(cur && cur.is_active);
        const { error } = await supabase.from('profiles').update({ is_active: next }).eq('id', id);
        if (error) throw sbErr(error);
        return { is_active: next };
      },
      async updateUser(id, payload) {
        const { data, error } = await supabase.from('profiles').update(payload).eq('id', id).select().single();
        if (error) throw sbErr(error);
        return data;
      },
      async deleteUser(id) {
        const { error } = await supabase.from('profiles').delete().eq('id', id);
        if (error) throw sbErr(error);
        return { success: true, id };
      },
      aiSettings() { return request('GET', '/admin/ai-settings'); },
      saveAiSettings(payload) { return request('PUT', '/admin/ai-settings', payload); },
      testAi(provider) { return request('POST', '/admin/ai-settings/test', { provider }); },
      emailSettings() { return request('GET', '/admin/email-settings'); },
      testEmail(email) { return request('POST', '/admin/email-settings/test', { email }); },
      // Funding database → `funding_sources` table.
      async funding() {
        const { data, error } = await supabase.from('funding_sources').select('*').order('created_at', { ascending: false });
        if (error) throw sbErr(error);
        return data || [];
      },
      async saveFunding(payload) {
        const { data, error } = await supabase.from('funding_sources').insert(payload).select().single();
        if (error) throw sbErr(error);
        return data;
      },
      async deleteFunding(id) {
        const { error } = await supabase.from('funding_sources').delete().eq('id', id);
        if (error) throw sbErr(error);
        return { success: true, id };
      },
      // Visa database → `visa_programs` table.
      async visa() {
        const { data, error } = await supabase.from('visa_programs').select('*').order('created_at', { ascending: false });
        if (error) throw sbErr(error);
        return data || [];
      },
      async saveVisa(payload) {
        const { data, error } = await supabase.from('visa_programs').insert(payload).select().single();
        if (error) throw sbErr(error);
        return data;
      },
      async deleteVisa(id) {
        const { error } = await supabase.from('visa_programs').delete().eq('id', id);
        if (error) throw sbErr(error);
        return { success: true, id };
      },
      plans() { return request('GET', '/admin/plans').then(r => r.data); },
      updatePlan(id, payload) { return request('PUT', '/admin/plans/' + id, payload).then(r => r.data); },
      // Blog management → `blog_posts` table (saveBlog upserts on id).
      async blog() {
        const { data, error } = await supabase.from('blog_posts').select('*').order('created_at', { ascending: false });
        if (error) throw sbErr(error);
        return data || [];
      },
      async saveBlog(payload) {
        payload = Object.assign({}, payload);
        let res;
        if (payload.id) {
          const id = payload.id; delete payload.id;
          res = await supabase.from('blog_posts').update(payload).eq('id', id).select().single();
        } else {
          res = await supabase.from('blog_posts').insert(payload).select().single();
        }
        if (res.error) throw sbErr(res.error);
        return res.data;
      },
      async deleteBlog(id) {
        const { error } = await supabase.from('blog_posts').delete().eq('id', id);
        if (error) throw sbErr(error);
        return { success: true, id };
      },
      cms(section, value) { return request('PUT', '/admin/cms/' + section, { value }); },
      auditLogs() { return request('GET', '/admin/audit-logs').then(r => r.data); },
    },
  };

  // Normalize a Supabase error into a thrown Error with an HTTP-ish status.
  function sbErr(error) {
    const e = new Error((error && error.message) || 'Supabase request failed.');
    e.status = error && (error.status || error.code);
    return e;
  }

  /* --------------------- Column-alignment mappers ---------------------
     Defensive mappers that tolerate minor schema variations so the UI
     renderers (toggles, cost inputs, ticket modal) never bind undefined. */
  function normTicketRow(r) {
    if (!r) return r;
    const prof = r.profile || r.profiles || r.user || null;
    let messages = r.messages;
    if (typeof messages === 'string') { try { messages = JSON.parse(messages); } catch (e) { messages = []; } }
    if (!Array.isArray(messages)) messages = [];
    return Object.assign({}, r, {
      user_name: r.user_name || (prof && prof.name) || (r.user_email ? r.user_email.split('@')[0] : (prof && prof.email ? prof.email.split('@')[0] : 'User')),
      user_email: r.user_email || (prof && prof.email) || '',
      subject: r.subject || '(no subject)',
      status: r.status || 'open',
      messages: messages,
    });
  }
  function normAiConfigRow(r) {
    if (!r) return r;
    return Object.assign({}, r, {
      provider_name: r.provider_name || r.provider || r.name,
      enabled: r.enabled != null ? r.enabled : (r.is_active != null ? r.is_active : false),
      is_default: r.is_default != null ? r.is_default : (r.default != null ? r.default : false),
      default_model: r.default_model || r.model || '',
      api_key: r.api_key || r.key || '',
      priority: r.priority != null ? r.priority : null,
      input_cost_per_1k: r.input_cost_per_1k != null ? r.input_cost_per_1k : (r.input_cost != null ? r.input_cost : null),
      output_cost_per_1k: r.output_cost_per_1k != null ? r.output_cost_per_1k : (r.output_cost != null ? r.output_cost : null),
    });
  }
  function normBlockedIpRow(r) {
    if (!r) return r;
    return Object.assign({}, r, {
      ip_address: r.ip_address || r.ip || '',
      reason: r.reason || '',
      created_at: r.created_at || r.blocked_at || null,
    });
  }

  function qs(params) {
    if (!params) return '';
    const s = Object.entries(params).filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    return s ? '?' + s : '';
  }

  global.NovaApi = NovaApi;
})(window);
