// Screenshot tour for checking the UI without a server: `npm run shot -- <out-dir>`.
// Runs the real app in a hidden window with its own user data folder and saves one PNG per step.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

process.env.RIMO_TEST = '1';
const out = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('shot.js')) || 'shots');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));

const { windowReady } = require('../main.js');
const model = process.env.RIMO_SHOT_MODEL || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

windowReady.then(async (win) => {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
    console.log('shot', name);
  };
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('console:', msg); });
  try {
    await wait(4000);
    await shot('1-discover');
    await js("rimoUI.submitSearch('qwen3 4b')");
    await wait(4000);
    await shot('2-search');
    await js(`rimoUI.openModel(${JSON.stringify(process.env.RIMO_SHOT_REPO || 'unsloth/Qwen3-4B-GGUF')})`);
    await wait(6000);
    await shot('3-detail');
    if (process.env.RIMO_SHOT_PULL) {
      // download through the UI and capture the progress bar
      await js(`document.querySelector('[data-action=pull][data-name=${JSON.stringify(process.env.RIMO_SHOT_PULL)}]').click()`);
      await wait(2500);
      await shot('3b-detail-pulling');
    }
    await js("rimoUI.go('models')");
    await wait(2500);
    await shot('4-models');
    if (model) {
      await js(`rimoUI.chatWith(${JSON.stringify(model)})`);
      await wait(1500);
      await shot('5-chat-empty');
      await js("rimoUI.sendMessage('Write a short markdown list with three fruits and one line of code in a python block.')");
      await wait(12000);
      console.log('chat state:', await js("JSON.stringify({streaming: !!rimoUI.state.streaming, msgs: rimoUI.state.chat && rimoUI.state.chat.messages.map(m => [m.role, (m.content||'').length, m.error||''])})"));
      await shot('6-chat');
      await js(`rimoUI.openModelSettings(${JSON.stringify(model)})`);
      await wait(2000);
      await shot('7-model-settings');
      await js("document.querySelector('[data-d=close]').click()");
    }
    await js("rimoUI.go('settings')");
    await wait(1500);
    await shot('8-settings');
  } catch (err) {
    console.error('shot failed:', err);
  }
  app.quit();
});
