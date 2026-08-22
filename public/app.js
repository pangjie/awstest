const form = document.querySelector('#message-form');
const authorInput = document.querySelector('#author');
const bodyInput = document.querySelector('#body');
const formMessage = document.querySelector('#form-message');
const characterCount = document.querySelector('#character-count');
const messagesElement = document.querySelector('#messages');
const statusElement = document.querySelector('#service-status');
const refreshButton = document.querySelector('#refresh-button');

function setFormMessage(message, type = '') {
  formMessage.textContent = message;
  formMessage.className = type;
}

function messageCard(message) {
  const article = document.createElement('article');
  article.className = 'message';

  const header = document.createElement('div');
  header.className = 'message-header';

  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = message.author;

  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.created_at;
  time.textContent = new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(message.created_at));

  const body = document.createElement('p');
  body.className = 'message-body';
  body.textContent = message.body;

  header.append(author, time);
  article.append(header, body);
  return article;
}

async function loadMessages() {
  refreshButton.disabled = true;
  try {
    const response = await fetch('/api/messages', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('读取失败');
    const { messages } = await response.json();

    messagesElement.replaceChildren();
    if (messages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = '数据库已经连接，等待第一条消息。';
      messagesElement.append(empty);
      return;
    }
    messagesElement.append(...messages.map(messageCard));
  } catch {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '暂时无法读取数据库，请稍后重试。';
    messagesElement.replaceChildren(empty);
  } finally {
    refreshButton.disabled = false;
  }
}

async function checkHealth() {
  try {
    const response = await fetch('/health/ready', { cache: 'no-store' });
    if (!response.ok) throw new Error('not ready');
    statusElement.className = 'status ready';
    statusElement.lastElementChild.textContent = '应用与数据库正常';
  } catch {
    statusElement.className = 'status failed';
    statusElement.lastElementChild.textContent = '服务暂不可用';
  }
}

bodyInput.addEventListener('input', () => {
  characterCount.value = bodyInput.value.length;
});

refreshButton.addEventListener('click', loadMessages);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setFormMessage('正在写入…');

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ author: authorInput.value, body: bodyInput.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '写入失败');

    bodyInput.value = '';
    characterCount.value = 0;
    setFormMessage('写入成功，可以刷新页面验证。', 'success');
    await loadMessages();
  } catch (error) {
    setFormMessage(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
});

checkHealth();
loadMessages();
