// =============================================
// サンプルデータ（ダミー社員を生成。実データと同じ列構成）
// =============================================
const SAMPLE_HEADER = ['tag_id','tag_name','user_id','first_name_ja','last_name_ja','first_name_en','last_name_en',
  'location_id','location_name','category_type','category_name','team_id','team_name','email','join_date','birthday'];

function buildSample() {
  const lastNames  = ['佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤','吉田','山田','佐々木','山口','松本','井上','木村','林','清水','斎藤'];
  const firstNames = ['太郎','花子','健','美咲','翔','結衣','大輔','葵','拓海','さくら','蓮','陽菜','悠真','凛','颯','楓'];
  const teams = ['TAMTO','TAMUNO','TAMKO','TAMOS','TAMBA'];
  const roles = ['エンジニア','デザイナー','ディレクター','経理','人事','プランナー'];
  // 東京18名・大阪10名・福岡3名・リモート2名
  const locs = [...Array(18).fill('東京'), ...Array(10).fill('大阪'), ...Array(3).fill('福岡'), ...Array(2).fill('リモート')];
  const rows = [SAMPLE_HEADER.join('\t')];
  locs.forEach((loc, i) => {
    const last  = lastNames[i % lastNames.length];
    const first = firstNames[(i * 7) % firstNames.length];
    const team  = teams[(i * 3) % teams.length];
    const role  = roles[(i * 5) % roles.length];
    const uid   = 'sample-' + String(i + 1).padStart(3, '0');
    rows.push(['tag-' + i, role, uid, first, last, '', '', 'loc', loc, '3', '職種', 'team', team,
      uid + '@example.com', '2020/4/1', ''].join('\t'));
  });
  return rows.join('\n');
}

// =============================================
// 状態
// =============================================
const LOCATIONS = ['東京', '大阪', 'その他'];
let allGroups = [];      // { no, loc, members: [person], ok, repeatTrio, recentPairs }
let unmatchedByLoc = {}; // loc → [person]（人数不足でグループにできなかった人）
let currentLoc = 'all';
let currentMonth = '';   // 'YYYY-MM'
let historyInfo = null;  // 読み込んだ履歴の集計

// =============================================
// UI操作
// =============================================
function loadSample() {
  document.getElementById('raw-data').value = buildSample();
}

function clearAll() {
  document.getElementById('raw-data').value = '';
  document.getElementById('exclude-members').value = '';
  document.getElementById('history-data').value = '';
  const errEl = document.getElementById('parse-err');
  errEl.style.display = 'none';
  errEl.innerHTML = '';
  document.getElementById('result-section').style.display = 'none';
  allGroups = [];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 実施月の初期値は今月
(function initMonth() {
  const d = new Date();
  document.getElementById('current-month').value =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

// =============================================
// 除外設定のパース
// =============================================
// 姓・名の間の空白（半角/全角）を除去し、小文字化して比較する
function normalizeName(s) {
  return (s || '').replace(/[\s　]+/g, '').toLowerCase();
}

function parseExcludedMembers(raw) {
  return new Set(
    raw.split('\n')
      .map(l => l.trim())
      .filter(l => l)
      .map(normalizeName)
  );
}

// =============================================
// データパース
//
// 1ユーザーが複数行（タグごと）に分かれていても user_id で1人にまとめる。
// 使用する列:
//   user_id                       → 人物の識別キー
//   last_name_ja + first_name_ja  → 表示名
//   location_name                 → 拠点（東京 / 大阪 / それ以外は「その他」）
//   team_name                     → 所属チーム
//   category_type=3 の tag_name   → 職種（表示用・任意）
// =============================================
function locationBucket(loc) {
  if (loc.includes('東京')) return '東京';
  if (loc.includes('大阪')) return '大阪';
  return 'その他';
}

function parseData(raw) {
  const lines = raw.replace(/\r/g, '').trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('データが少なすぎます（ヘッダー＋1行以上必要）');

  const headers = lines[0].split('\t').map(h => h.trim());
  const need = ['user_id', 'first_name_ja', 'last_name_ja', 'location_name', 'team_name'];
  const optional = ['category_type', 'tag_name'];
  const idx = {};
  need.forEach(k => {
    const i = headers.indexOf(k);
    if (i === -1) throw new Error(`列「${k}」が見つかりません。ヘッダー行を確認してください。`);
    idx[k] = i;
  });
  optional.forEach(k => { idx[k] = headers.indexOf(k); });

  const col = (cols, k) => (idx[k] >= 0 ? (cols[idx[k]] || '').trim() : '');
  const map = new Map(); // user_id → person

  lines.slice(1).forEach(line => {
    const cols = line.split('\t');
    const uid = col(cols, 'user_id');
    if (!uid) return;

    if (!map.has(uid)) {
      const firstName = col(cols, 'first_name_ja');
      const lastName  = col(cols, 'last_name_ja');
      const location  = col(cols, 'location_name');
      map.set(uid, {
        uid,
        firstName,
        lastName,
        name: (lastName + ' ' + firstName).trim(),
        location,
        bucket: locationBucket(location),
        team: col(cols, 'team_name'),
        roles: []
      });
    }

    const p = map.get(uid);
    const tag = col(cols, 'tag_name');
    if (col(cols, 'category_type') === '3' && tag && !p.roles.includes(tag)) p.roles.push(tag);
  });

  const skipped = [];
  const people = [];
  map.forEach(p => {
    const missing = [];
    if (!p.lastName)  missing.push('last_name_ja');
    if (!p.firstName) missing.push('first_name_ja');
    if (!p.location)  missing.push('location_name');
    if (!p.team)      missing.push('team_name');
    if (missing.length) skipped.push({ name: p.name || p.uid, missing });
    else people.push(p);
  });

  return { people, skipped };
}

// =============================================
// 履歴パース
//
// 履歴シート（「TSVコピー」の出力を追記していったもの）を読み込む。
//   実施月 + グループ → 1つのランチグループ
//   user_id（なければ 氏名）→ 人物の照合キー
//
// 返す集合:
//   trios : 過去の全グループに含まれる「3人の組み合わせ」すべて（期間無制限）
//   pairs : 直近 pairWindow か月のグループに含まれる「2人の組み合わせ」すべて
// 今回の実施月以降の履歴は（再実行時の二重カウントを防ぐため）無視する。
// =============================================

// '2026-10' / '2026/10' / '2026/10/1' / '2026年10月' → 2026*12+9 の通し月番号
function monthIndex(s) {
  const m = String(s || '').match(/(\d{4})\D+(\d{1,2})/);
  if (!m) return NaN;
  const mon = parseInt(m[2], 10);
  if (mon < 1 || mon > 12) return NaN;
  return parseInt(m[1], 10) * 12 + (mon - 1);
}

function combos(arr, k) {
  const out = [];
  const rec = (start, picked) => {
    if (picked.length === k) { out.push(picked.slice()); return; }
    for (let i = start; i < arr.length; i++) { picked.push(arr[i]); rec(i + 1, picked); picked.pop(); }
  };
  rec(0, []);
  return out;
}

const comboKey = ids => ids.slice().sort().join('|');

function parseHistory(raw, people, curIdx, pairWindow) {
  const empty = { trios: new Set(), pairs: new Set(), groupCount: 0, recentCount: 0, ignoredFuture: 0, unknown: [] };
  const lines = raw.replace(/\r/g, '').trim().split('\n').filter(l => l.trim());
  if (!lines.length) return empty;

  const headers = lines[0].split('\t').map(h => h.trim());
  const iMonth = headers.indexOf('実施月');
  const iGroup = headers.indexOf('グループ');
  const iUid   = headers.indexOf('user_id');
  const iName  = headers.indexOf('氏名');
  if (iMonth === -1) throw new Error('履歴に列「実施月」が見つかりません。ヘッダー行を確認してください。');
  if (iGroup === -1) throw new Error('履歴に列「グループ」が見つかりません。ヘッダー行を確認してください。');
  if (iUid === -1 && iName === -1) throw new Error('履歴に列「user_id」または「氏名」が必要です。');

  const byName = new Map(people.map(p => [normalizeName(p.name), p.uid]));
  const groups = new Map(); // '月|グループ' → { idx, ids:Set }
  const unknown = new Set();

  lines.slice(1).forEach(line => {
    const cols = line.split('\t');
    const idx = monthIndex(cols[iMonth]);
    const g = (cols[iGroup] || '').trim();
    if (isNaN(idx) || !g) return;
    let id = iUid >= 0 ? (cols[iUid] || '').trim() : '';
    if (!id && iName >= 0) {
      const nm = normalizeName(cols[iName]);
      if (!nm) return;
      id = byName.get(nm) || 'name:' + nm;
      if (!byName.has(nm)) unknown.add((cols[iName] || '').trim());
    }
    if (!id) return;
    const key = idx + '|' + g;
    if (!groups.has(key)) groups.set(key, { idx, ids: new Set() });
    groups.get(key).ids.add(id);
  });

  const res = { ...empty, unknown: [...unknown] };
  groups.forEach(({ idx, ids }) => {
    if (idx >= curIdx) { res.ignoredFuture++; return; }
    const arr = [...ids];
    if (arr.length < 2) return;
    res.groupCount++;
    combos(arr, 3).forEach(c => res.trios.add(comboKey(c)));
    if (pairWindow > 0 && idx >= curIdx - pairWindow) {
      res.recentCount++;
      combos(arr, 2).forEach(c => res.pairs.add(comboKey(c)));
    }
  });
  return res;
}

// =============================================
// グループ分けロジック
//
// ・拠点（東京 / 大阪 / その他）ごとに3人組をつくる
// ・NG条件（必ず避ける）:
//     - グループ全員が同じチーム（2人同じ＋1人別はOK）
//     - 過去に同じグループだった3人がそろう（4人組・5人組の中に含まれる場合も）
// ・なるべく避ける: 直近の指定期間に同じグループだった2人
// ・職種は考慮しない
// ・3で割り切れない場合：余り1 → 4人組×1、余り2 → 4人組×2
//   （5人だけの拠点は 5人組×1、2人以下の拠点はグループを作らず警告）
//
// 方式: ランダムに区切った後、問題のあるグループのメンバーを他グループと
//       入れ替える局所探索。コスト（NG=1000点、直近ペア=1点）が下がらない
//       入れ替えは戻す。何度かやり直して最もコストの低い結果を採用する。
// =============================================
const HARD = 1000;

function randInt(n) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function groupSizes(n) {
  if (n < 3) return [];
  if (n === 5) return [5];
  const rem = n % 3;
  const fours = rem === 0 ? 0 : rem === 1 ? 1 : 2;
  const threes = (n - fours * 4) / 3;
  return [...Array(threes).fill(3), ...Array(fours).fill(4)];
}

// グループの問題点を調べる
function inspectGroup(members, hist) {
  const ids = members.map(p => p.uid);
  const sameTeam = new Set(members.map(p => p.team)).size <= 1;
  const repeatTrio = hist ? combos(ids, 3).some(c => hist.trios.has(comboKey(c))) : false;
  const recentPairs = hist && hist.pairs.size
    ? combos(members, 2).filter(([a, b]) => hist.pairs.has(comboKey([a.uid, b.uid])))
    : [];
  return { sameTeam, repeatTrio, recentPairs };
}

function groupCost(members, hist) {
  const r = inspectGroup(members, hist);
  return (r.sameTeam ? HARD : 0) + (r.repeatTrio ? HARD : 0) + r.recentPairs.length;
}

function makeGroups(people, hist) {
  const sizes = groupSizes(people.length);
  if (!sizes.length) return [];

  // 探索中の入れ替え位置は軽い Math.random で選ぶ（初期の並びは crypto で十分ランダム）
  const rnd = n => Math.floor(Math.random() * n);
  const deadline = Date.now() + 1500; // 条件を満たせない場合でも1.5秒で打ち切る
  let best = null;
  for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt++) {
    const pool = shuffle(people);
    const groups = [];
    let k = 0;
    sizes.forEach(s => { groups.push(pool.slice(k, k + s)); k += s; });
    const costs = groups.map(g => groupCost(g, hist));
    let total = costs.reduce((a, b) => a + b, 0);
    let lastImproved = 0;

    for (let iter = 0; iter < 20000 && total > 0 && groups.length > 1; iter++) {
      if (iter - lastImproved > 3000) break; // 改善が止まったらやり直し
      const badIdx = costs.map((c, i) => (c > 0 ? i : -1)).filter(i => i >= 0);
      const a = badIdx[rnd(badIdx.length)];
      let b = rnd(groups.length - 1);
      if (b >= a) b++;
      const i = rnd(groups[a].length), j = rnd(groups[b].length);
      [groups[a][i], groups[b][j]] = [groups[b][j], groups[a][i]];
      const ca = groupCost(groups[a], hist), cb = groupCost(groups[b], hist);
      const delta = ca + cb - costs[a] - costs[b];
      if (delta <= 0) {
        if (delta < 0) lastImproved = iter;
        total += delta;
        costs[a] = ca; costs[b] = cb;
      } else {
        [groups[a][i], groups[b][j]] = [groups[b][j], groups[a][i]]; // 戻す
      }
    }

    if (!best || total < best.total) best = { groups: groups.map(g => g.slice()), total };
    if (total === 0) break;
  }
  return best.groups;
}

// =============================================
// 実行
// =============================================
function parseAndRun() {
  const raw = document.getElementById('raw-data').value;
  const errEl = document.getElementById('parse-err');
  errEl.style.display = 'none';
  errEl.classList.remove('warn');
  errEl.innerHTML = '';

  const msgs = [];
  try {
    const { people: allPeople, skipped } = parseData(raw);

    const excludedNames = parseExcludedMembers(document.getElementById('exclude-members').value);
    const excludedPeople = allPeople.filter(p => excludedNames.has(normalizeName(p.name)));
    const people = allPeople.filter(p => !excludedNames.has(normalizeName(p.name)));

    if (skipped.length) {
      msgs.push('⚠️ 以下のユーザーは必須項目が空欄のためスキップしました：<br>' +
        skipped.map(s => `・${escapeHtml(s.name)}（${s.missing.join('、')}が空欄）`).join('<br>'));
    }
    if (excludedPeople.length) {
      msgs.push('ℹ️ 以下のユーザーは除外設定により対象から外しました：<br>' +
        excludedPeople.map(p => `・${escapeHtml(p.name)}`).join('<br>'));
    }
    const foundNames = new Set(allPeople.map(p => normalizeName(p.name)));
    const notFound = [...excludedNames].filter(n => !foundNames.has(n));
    if (notFound.length) {
      msgs.push('⚠️ 除外メンバーのうち、データに見つからなかった名前があります：<br>' +
        notFound.map(n => `・${escapeHtml(n)}`).join('<br>'));
    }

    if (people.length < 3) throw new Error('有効な社員データが3名以上必要です');

    // 履歴
    currentMonth = document.getElementById('current-month').value;
    const curIdx = monthIndex(currentMonth);
    const historyRaw = document.getElementById('history-data').value.trim();
    let hist = null;
    historyInfo = null;
    if (historyRaw) {
      if (isNaN(curIdx)) throw new Error('履歴を使うときは「今回の実施月」を入力してください。');
      const pairWindow = parseInt(document.getElementById('pair-window').value, 10);
      hist = parseHistory(historyRaw, allPeople, curIdx, pairWindow);
      historyInfo = { ...hist, pairWindow };
      msgs.push(`ℹ️ 履歴を読み込みました：過去${hist.groupCount}グループ（同じ3人を避ける対象）` +
        (pairWindow > 0 ? `、うち直近${pairWindow}か月の${hist.recentCount}グループ（同じ2人をなるべく避ける対象）` : ''));
      if (hist.ignoredFuture) {
        msgs.push(`ℹ️ 今回の実施月（${escapeHtml(currentMonth)}）以降の履歴${hist.ignoredFuture}グループは対象外にしました。`);
      }
      if (hist.unknown.length) {
        msgs.push('⚠️ 履歴の氏名のうち、社員データに見つからなかった人がいます（退職者などは問題ありません）：' +
          hist.unknown.map(escapeHtml).join('、'));
      }
    }

    allGroups = [];
    unmatchedByLoc = {};
    let no = 1;
    LOCATIONS.forEach(loc => {
      const members = people.filter(p => p.bucket === loc);
      if (!members.length) return;
      if (members.length < 3) {
        unmatchedByLoc[loc] = members;
        msgs.push(`⚠️ ${loc}は${members.length}名のためグループを作れませんでした：` +
          members.map(p => escapeHtml(p.name)).join('、'));
        return;
      }
      const groups = makeGroups(members, hist);
      groups.forEach(g => {
        const r = inspectGroup(g, hist);
        allGroups.push({ no: no++, loc, members: g, ok: !r.sameTeam && !r.repeatTrio, ...r });
      });
      const locGroups = allGroups.filter(g => g.loc === loc);
      if (locGroups.some(g => g.sameTeam)) {
        msgs.push(`⚠️ ${loc}は特定チームの人数が多いため、「全員同じチーム」のグループを完全には避けられませんでした（赤枠のグループ）。`);
      }
      if (locGroups.some(g => g.repeatTrio)) {
        msgs.push(`⚠️ ${loc}は「過去と同じ3人」を完全には避けられませんでした（赤枠のグループ）。`);
      }
      if (locGroups.some(g => g.recentPairs.length)) {
        msgs.push(`ℹ️ ${loc}は人数の都合で、直近に同じグループだった2人が一部重なっています（黄枠のグループ）。`);
      }
    });

    if (msgs.length) {
      errEl.innerHTML = msgs.join('<br><br>');
      errEl.classList.add('warn');
      errEl.style.display = 'block';
    }

    renderStats(people.length);
    renderGroups();
    document.getElementById('result-section').style.display = 'block';
    document.getElementById('result-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    msgs.push('❌ ' + escapeHtml(e.message));
    errEl.innerHTML = msgs.join('<br><br>');
    errEl.classList.remove('warn');
    errEl.style.display = 'block';
  }
}

// =============================================
// 表示
// =============================================
const badgeClass = { '東京': 'badge-1', '大阪': 'badge-2', 'その他': 'badge-3' };

function renderStats(total) {
  const groupCount = loc => allGroups.filter(g => g.loc === loc).length;
  const unmatched = Object.values(unmatchedByLoc).flat().length;
  document.getElementById('stats-area').innerHTML = `
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">参加者数</div></div>
    <div class="stat"><div class="stat-num">${allGroups.length}</div><div class="stat-label">総グループ数</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--c1)">${groupCount('東京')}</div><div class="stat-label">東京</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--c2)">${groupCount('大阪')}</div><div class="stat-label">大阪</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--c3)">${groupCount('その他')}</div><div class="stat-label">その他</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--err)">${unmatched}</div><div class="stat-label">未割当</div></div>
    <div class="stat"><div class="stat-num" style="color:var(--c4)">${historyInfo ? historyInfo.groupCount : '-'}</div><div class="stat-label">履歴グループ</div></div>`;
}

function filterLoc(loc) {
  currentLoc = loc;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.loc === loc));
  renderGroups();
}

function visibleLocations() {
  return currentLoc === 'all' ? LOCATIONS : [currentLoc];
}

function groupNotes(g) {
  const notes = [];
  if (g.sameTeam) notes.push('全員同じチーム');
  if (g.repeatTrio) notes.push('過去と同じ3人を含む');
  g.recentPairs.forEach(([a, b]) => notes.push(`直近で同席：${escapeHtml(a.name)}・${escapeHtml(b.name)}`));
  return notes;
}

function renderGroups() {
  const area = document.getElementById('group-area');
  let html = '';
  visibleLocations().forEach(loc => {
    const groups = allGroups.filter(g => g.loc === loc);
    const unmatched = unmatchedByLoc[loc] || [];
    if (!groups.length && !unmatched.length) return;
    const n = groups.reduce((s, g) => s + g.members.length, 0);
    html += `<div class="loc-heading"><span class="badge ${badgeClass[loc]}">${loc}</span>
      <span class="count">${groups.length}グループ / ${n}名</span></div>`;
    groups.forEach(g => {
      const notes = groupNotes(g);
      const cls = !g.ok ? ' bad' : g.recentPairs.length ? ' soft' : '';
      html += `<div class="group-card${cls}">
        <div class="group-head">
          <span class="group-no">G${String(g.no).padStart(2, '0')}</span>
          <span class="badge ${badgeClass[loc]}">${loc}</span>
          <span class="group-size">${g.members.length}人</span>
        </div>
        ${g.members.map(p => `<div class="member">
          <div class="person-name">${escapeHtml(p.name)}</div>
          <div class="person-meta">${escapeHtml(p.team)}${p.roles.length ? ' · ' + escapeHtml(p.roles.join('・')) : ''}${p.bucket === 'その他' ? ' · ' + escapeHtml(p.location) : ''}</div>
        </div>`).join('')}
        ${notes.length ? `<div class="group-note">${notes.join('<br>')}</div>` : ''}
      </div>`;
    });
    if (unmatched.length) {
      html += `<div class="unmatched">未割当：${unmatched.map(p => escapeHtml(p.name)).join('、')}</div>`;
    }
  });
  area.innerHTML = html || '<div class="empty">グループがありません</div>';
}

// =============================================
// コピー
// =============================================
function flashButton(ev) {
  const btn = ev.target.closest('button');
  const orig = btn.innerHTML;
  btn.innerHTML = '✓ コピーしました！';
  btn.style.color = 'var(--accent)';
  setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2000);
}

function copyAnnounce(ev) {
  const title = document.getElementById('announce-title').value.trim();
  const footer = document.getElementById('announce-footer').value.trim();
  const lines = [];
  if (title) lines.push(title, '');
  visibleLocations().forEach(loc => {
    const groups = allGroups.filter(g => g.loc === loc);
    if (!groups.length) return;
    lines.push(`■ ${loc}`);
    groups.forEach(g => {
      lines.push(`G${String(g.no).padStart(2, '0')}：` +
        g.members.map(p => `${p.name}（${p.team}）`).join(' / '));
    });
    lines.push('');
  });
  if (footer) lines.push(footer);
  navigator.clipboard.writeText(lines.join('\n').trim()).then(() => flashButton(ev));
}

// 履歴シートにそのまま追記できる形式（1行目のヘッダーは履歴シートの初回のみ必要）
function copyTSV(ev) {
  const header = '実施月\tグループ\t拠点\tuser_id\t氏名\tチーム\t職種\t登録拠点';
  const rows = [];
  visibleLocations().forEach(loc => {
    allGroups.filter(g => g.loc === loc).forEach(g => {
      g.members.forEach(p => {
        rows.push([currentMonth, `G${String(g.no).padStart(2, '0')}`, loc, p.uid, p.name, p.team,
          p.roles.join('・'), p.location].join('\t'));
      });
    });
  });
  navigator.clipboard.writeText([header, ...rows].join('\n')).then(() => flashButton(ev));
}
