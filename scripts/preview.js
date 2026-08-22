import { createApp } from '../src/server.js';

const messages = [{
  id: 1,
  author: '部署检查',
  body: '这是一条本地预览数据。云端部署后，这里会显示来自 RDS PostgreSQL 的记录。',
  created_at: new Date().toISOString()
}];

const db = {
  async isReady() {},
  async listMessages() { return [...messages].reverse(); },
  async createMessage(author, body) {
    const message = {
      id: messages.length + 1,
      author,
      body,
      created_at: new Date().toISOString()
    };
    messages.push(message);
    return message;
  }
};

const server = createApp({ db });
server.listen(3131, '127.0.0.1', () => {
  console.log('Preview available at http://127.0.0.1:3131');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
