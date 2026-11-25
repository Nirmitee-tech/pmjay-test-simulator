'use strict';
const { createApp } = require('./app');
const app = createApp();
app.server.listen(app.cfg.port, app.cfg.host, () => {
  console.log(`pmjaymock (NHCX + ${app.cfg.payerCode}) on http://localhost:${app.cfg.port} callbacks -> ${app.cfg.callbackBase}`);
});
