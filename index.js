const { SocketReader, defaultMaxLength } = require("./socketReader");

const defaultHost = "kereon.lisptick.org";
const defaultPort = 8080;
const defaultCode = "(version)";

class Status {
  constructor() {
    this.result = undefined;
    this.isError = false;
    this.currentOption = "default";
    this.serieIds = new Map();
    this.serieTbPos = new Map();
    this.serieLabels = [];
    this.labelToGaugeIndex = new Map();
    this.neededLabels = 0;
    this.arrays = new Map();
    this.arrayWhere = new Map();
    this.tbArrays = new Map();
    this.datas = [];
    this.length = 0;
    this.buffer = undefined;
  }
}

function encodeLispTick(lisptickCode) {
  let base = new TextEncoder("utf-8").encode(
    JSON.stringify({
      code: lisptickCode,
    })
  );
  if (base.length > 65535) {
    base = new TextEncoder("utf-8").encode(
      JSON.stringify({
        code: "Message too long, must be < 64KB",
      })
    );
  }
  let with_size = new Uint8Array(base.length + 2);
  with_size.set(base, 2);
  with_size.set([base.length % 256, base.length >>> 8], 0);
  return with_size;
}

class LisptickSocket {
  constructor(host=defaultHost, port=defaultPort, maxLength=defaultMaxLength) {
    this.socketReader = new SocketReader(maxLength);
    this.host = host;
    this.port = port;
    this.maxLength = maxLength;

    this.client = new WebSocket(
      `${location.protocol == "https:" ? "wss://" : "ws://"}${
        this.host + ':' + this.port
      }/ws`
    );
    this.client.binaryType = "arraybuffer";
  }

  send(lisptickCode=defaultCode) {
    // On WebSocket connection
    this.client.onopen = () => {
      this.socketReader.status = new Status();
      this.socketReader.level = 0;
      this.socketReader.ws_buffer = new ArrayBuffer(0);

      // send lisptick code
      this.client.send(encodeLispTick(lisptickCode));
    }
  }

  listen(message, setStateFunction, callback=undefined, callbackClose=undefined) {


    switch (message) {
      case 'message':
        // TODO manage error message withtout state func
        this.socketReader.setStateFunction = setStateFunction;

        // On WebSocket message
        this.client.onmessage = (msg) => {
          if (this.socketReader.status.length > this.maxLength) {
            this.client.close();
          }

          if (msg.data instanceof ArrayBuffer) {
            this.socketReader.ws_buffer = this.socketReader.concatBuffers(
              this.socketReader.ws_buffer,
              msg.data
            );
          }

          if (this.socketReader.consumeResult()) return;
          if (
            this.socketReader.status.neededLabels >
            this.socketReader.status.serieLabels.length
          )
            return;
          if (this.socketReader.status.buffer != undefined) return;
        };
        break;
      case 'error':
        // On WebSocket error
        this.client.onerror = (err) => {
          console.log("ERROR: " + err);
        };
        break;
      case 'close':
        // On WebSocket closing
        this.client.onclose = (msg) => {
          if (typeof callbackClose === 'function')
            callbackClose();
          if (this.socketReader.ws_buffer.byteLength > 12) {
            this.socketReader.consumeResult();
          }
        };
        break;
      default:
        break;
    }

    if (typeof callback === 'function') {
      callback();
    }
  }

  close() {
    this.client.close();
  }
} 

module.exports = {
  LisptickSocket,
};
