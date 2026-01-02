/* global overwolf */
const statusText = document.getElementById('statusText');

function updateStatus(text) {
  if (statusText) {
    statusText.textContent = text;
  }
}

function sendNativeCommand(command) {
  // Placeholder: wire to native input hook module or Overwolf game events.
  console.log(`Clicksmith command: ${command}`);
}

document.getElementById('recordBtn')?.addEventListener('click', () => {
  updateStatus('Recording...');
  sendNativeCommand('record:start');
});

document.getElementById('playBtn')?.addEventListener('click', () => {
  updateStatus('Playing...');
  sendNativeCommand('play:start');
});

document.getElementById('takeoverBtn')?.addEventListener('click', () => {
  updateStatus('Takeover active');
  sendNativeCommand('takeover');
});

document.getElementById('overlayRecord')?.addEventListener('click', () => sendNativeCommand('record:start'));
document.getElementById('overlayPlay')?.addEventListener('click', () => sendNativeCommand('play:start'));
document.getElementById('overlayTakeover')?.addEventListener('click', () => sendNativeCommand('takeover'));

if (typeof overwolf !== 'undefined' && overwolf.settings?.hotkeys) {
  overwolf.settings.hotkeys.onPressed.addListener((event) => {
    switch (event.name) {
      case 'toggle_recording':
        sendNativeCommand('record:toggle');
        break;
      case 'toggle_playback':
        sendNativeCommand('play:toggle');
        break;
      case 'takeover':
        sendNativeCommand('takeover');
        break;
      default:
        break;
    }
  });
}
