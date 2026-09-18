/***** ========== 設定（ここだけ入力） ========== *****/
const BACKLOG_SPACE = 'unerry';
const BACKLOG_API_KEY = '';
const BACKLOG_PROJECT_ID = 5779;

const SLACK_BOT_TOKEN = '';
const SLACK_CHANNEL_ID = 'C09MDSHQP3K';

const SPREADSHEET_ID = '';
const SHEET_NAME = '期限通知リスト';
const MEMBER_SHEET_NAME = 'メンバー表';

const REMIND_DAYS_BEFORE = 1;
const COMPLETE_STATUS_NAMES = ['完了', 'Closed', 'Resolved'];

/***** ========== メイン処理 ========== *****/
function runDailyReminders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('skip: could not acquire lock');
    return;
  }
  try {
    if (!BACKLOG_SPACE || !BACKLOG_API_KEY || !BACKLOG_PROJECT_ID) throw new Error('Backlog設定が未設定です。');
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) throw new Error('Slack設定が未設定です。');
    if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID が未設定です。');

    const USER_MAPPING = loadUserMappingFromSheet_(SPREADSHEET_ID, MEMBER_SHEET_NAME);
    const sheet = getOrCreateSheet_(SPREADSHEET_ID, SHEET_NAME);
    const todayYmd = formatDateJST_(new Date(), 'yyyy-MM-dd');
    
    // 1) 期限が N 日後の課題を取得（未完のみ）
    const targetYmd = getFutureDateJST_(REMIND_DAYS_BEFORE);
    const dueIssues = fetchIssuesDueOn_(BACKLOG_SPACE, BACKLOG_API_KEY, BACKLOG_PROJECT_ID, targetYmd);
    
    dueIssues.forEach(issue => {
      if (isCompleted_(issue)) return;
      const assigneeId = issue.assignee ? String(issue.assignee.id) : null;
      const slackId = assigneeId ? USER_MAPPING[assigneeId] : null;

      const existingRow = findRowByIssueKey_(sheet, issue.issueKey);
      if (existingRow) {
        const idx = headerIndexMap_(sheet);
        const lastNotified = String(sheet.getRange(existingRow, idx['最終通知日'] + 1).getValue() || '');
        if (lastNotified === todayYmd || hasAlreadySentToday_(issue.issueKey)) {
          upsertRow_(sheet, issue, slackId, false);
          return;
        }
      }

      let didNotify = false;
      // 期限が設定されている場合のみ通知
      if (slackId && issue.dueDate) {
        didNotify = postSlackReminder_(slackId, issue);
      }
      upsertRow_(sheet, issue, slackId, didNotify);
    });

    // 2) 既存リストの再チェックと更新
    reNotifyActiveList_(sheet, BACKLOG_SPACE, BACKLOG_API_KEY, USER_MAPPING);
    
    // 3) 完了済み削除
    pruneCompleted_(sheet, BACKLOG_SPACE, BACKLOG_API_KEY);
  } finally {
    lock.releaseLock();
  }
}

/***** ========== 再通知＆リスト更新（期限日同期対応） ========== *****/
function reNotifyActiveList_(sheet, space, apiKey, userMapping) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const header = values[0];
  const rows = values.slice(1);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const todayYmd = formatDateJST_(new Date(), 'yyyy-MM-dd');
  const targetYmd = getFutureDateJST_(REMIND_DAYS_BEFORE);

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const issueKey = row[idx['課題キー']];
    if (!issueKey) return;

    // Backlogから最新情報を取得
    const issue = fetchIssueByKey_(space, apiKey, issueKey);
    if (!issue.issueKey || isCompleted_(issue)) return;

    // スプレッドシート側の情報を最新化（期限日や登録者含む）
    let slackId = String(row[idx['SlackユーザーID']] || '').trim();
    if (!slackId && issue.assignee && userMapping[issue.assignee.id]) {
        slackId = userMapping[issue.assignee.id];
    }
    
    const lastNotified = String(row[idx['最終通知日']] || '');
    const currentDueYmd = issue.dueDate ? formatDateJST_(new Date(issue.dueDate), 'yyyy-MM-dd') : null;

    // 通知が必要かどうかの判定
    let didNotify = false;
    // 条件: 今日まだ送っていない 且つ 期限が設定されている 且つ (期限超過 または 通知対象日)
    if (lastNotified !== todayYmd && !hasAlreadySentToday_(issueKey) && currentDueYmd) {
      if (currentDueYmd <= targetYmd && slackId) {
        didNotify = postSlackReminder_(slackId, issue);
      }
    }

    // 常に最新情報で上書き（期限日が変わっていてもここで更新される）
    upsertRow_(sheet, issue, slackId, didNotify);
  });
}

/***** ========== Slack通知 ========== *****/
function postSlackReminder_(slackUserId, issue) {
  if (hasAlreadySentToday_(issue.issueKey)) return false;

  const issueUrl = `https://${BACKLOG_SPACE}.backlog.com/view/${issue.issueKey}`;
  const dueDate = issue.dueDate ? new Date(issue.dueDate) : null;
  const dueStr = dueDate ? formatDateJST_(dueDate, 'yyyy/MM/dd') : '未設定';
  const todayYmd = formatDateJST_(new Date(), 'yyyy-MM-dd');
  const dueYmd = dueDate ? formatDateJST_(dueDate, 'yyyy-MM-dd') : null;

  let statusText = '';
  if (dueYmd && dueYmd < todayYmd) {
    statusText = `⚠️ <@${slackUserId}> 期限日が過ぎています！`;
  } else if (dueYmd === todayYmd) {
    statusText = `⏰ <@${slackUserId}> 本日が期限日です！`;
  } else {
    statusText = `⏰ <@${slackUserId}> 期限が近づいています！`;
  }

  const text = `${statusText}\n` +
               `📌 *課題*: <${issueUrl}|${escapeMarkdown_(issue.summary)}>\n` +
               `📅 *期限日*: ${dueStr}\n` +
               `👤 *担当*: ${issue.assignee ? issue.assignee.name : '未割当'}`;

  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    payload: JSON.stringify({ channel: SLACK_CHANNEL_ID, text }),
    muteHttpExceptions: true,
  });

  try {
    const body = JSON.parse(res.getContentText() || '{}');
    if (body.ok) {
      markSentToday_(issue.issueKey);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

/***** ========== Backlog API関連 ========== *****/
function fetchIssuesDueOn_(space, apiKey, projectId, ymd) {
  const base = `https://${space}.backlog.com/api/v2/issues`;
  const url = `${base}?apiKey=${encodeURIComponent(apiKey)}&projectId[]=${encodeURIComponent(projectId)}` +
              `&dueDateSince=${encodeURIComponent(ymd)}&dueDateUntil=${encodeURIComponent(ymd)}&count=100`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return JSON.parse(res.getContentText() || '[]').filter(i => !isCompleted_(i));
}

function fetchIssueByKey_(space, apiKey, issueKey) {
  const url = `https://${space}.backlog.com/api/v2/issues/${encodeURIComponent(issueKey)}?apiKey=${encodeURIComponent(apiKey)}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return JSON.parse(res.getContentText() || '{}');
}

function isCompleted_(issue) {
  const name = issue && issue.status && issue.status.name ? String(issue.status.name) : '';
  return COMPLETE_STATUS_NAMES.includes(name);
}

/***** ========== スプレッドシート操作 ========== *****/
function getOrCreateSheet_(spreadsheetId, sheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  const header = [
    '課題キー', '件名', '期限日', '担当者ID', '担当者名',
    'SlackユーザーID', 'ステータス', '最終通知日', '課題リンク', '登録者'
  ];
  const firstRow = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  if (firstRow.join('') !== header.join('')) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
  return sheet;
}

function findRowByIssueKey_(sheet, issueKey) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(issueKey)) return i + 1;
  }
  return null;
}

function headerIndexMap_(sheet) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return Object.fromEntries(header.map((h, i) => [h, i]));
}

function upsertRow_(sheet, issue, slackUserId, didNotify) {
  const idx = headerIndexMap_(sheet);
  const issueUrl = `https://${BACKLOG_SPACE}.backlog.com/view/${issue.issueKey}`;
  const dueStr = issue.dueDate ? formatDateJST_(new Date(issue.dueDate), 'yyyy-MM-dd') : '';
  const todayYmd = formatDateJST_(new Date(), 'yyyy-MM-dd');
  
  const existingRow = findRowByIssueKey_(sheet, issue.issueKey);
  let lastNotified = '';
  if (existingRow) {
    lastNotified = String(sheet.getRange(existingRow, idx['最終通知日'] + 1).getValue() || '');
  }
  
  const nextLastNotified = didNotify ? todayYmd : lastNotified;
  
  // 登録者名の取得（作成者: createdUser）
  const createdUserName = issue.createdUser ? issue.createdUser.name : '';

  const rowValues = [
    issue.issueKey,
    issue.summary,
    dueStr,
    issue.assignee ? issue.assignee.id : '',
    issue.assignee ? issue.assignee.name : '',
    slackUserId || '',
    issue.status ? issue.status.name : '',
    nextLastNotified,
    issueUrl,
    createdUserName // J列: 登録者
  ];

  if (existingRow) {
    sheet.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

function pruneCompleted_(sheet, space, apiKey) {
  const values = sheet.getDataRange().getValues();
  const idx = headerIndexMap_(sheet);
  const toDelete = [];
  for (let i = 1; i < values.length; i++) {
    const issueKey = values[i][0];
    if (!issueKey) continue;
    const issue = fetchIssueByKey_(space, apiKey, issueKey);
    if (isCompleted_(issue)) toDelete.push(i + 1);
  }
  toDelete.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
}

/***** ========== メンバー表・ユーティリティ ========== *****/
function loadUserMappingFromSheet_(spreadsheetId, memberSheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(memberSheetName);
  if (!sheet) return {};
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const bIdx = header.findIndex(h => h.includes('backlog'));
  const sIdx = header.findIndex(h => h.includes('slack'));
  if (bIdx === -1 || sIdx === -1) return {};
  const map = {};
  for (let r = 1; r < values.length; r++) {
    const bId = String(values[r][bIdx]).trim();
    const sId = String(values[r][sIdx]).trim();
    if (bId && sId) map[bId] = sId;
  }
  return map;
}

function hasAlreadySentToday_(issueKey) {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty(`sent_${issueKey}_${_todayYmd_()}`) === '1';
}

function markSentToday_(issueKey) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(`sent_${issueKey}_${_todayYmd_()}`, '1');
}

function _todayYmd_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function getFutureDateJST_(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function formatDateJST_(date, pattern) {
  return Utilities.formatDate(date, 'Asia/Tokyo', pattern);
}

function escapeMarkdown_(text) {
  if (!text) return '';
  return String(text).replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]));
}
