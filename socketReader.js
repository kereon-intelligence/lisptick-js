const defaultMaxLength = 200000;

let d64Factors = [];
for (let i = 0; i < 129; i++) {
  d64Factors[i] = Math.pow(10.0, i);
}

const TYPE = Object.freeze({
  TNull: 0,
  TInt: 1,
  TFloat: 2,
  TTime: 3,
  TDuration: 4,
  TError: 5,
  TString: 6,
  TArray: 7,
  TArraySerial: 8,
  TTimeSerie: 9,
  TSentinel: 10,
  TBool: 11,
  TDec64: 12,
  TPair: 13,
  THeartBeat: 14,
  TTensor: 15,
});

class Tensor {
  constructor(shape) {
    this.shape = shape;
    this.dim = shape.length;
    this.min = undefined;
    this.max = undefined;
    this.size = this.sizefromShape();
    this.values = new Array(this.size);
    this.i = 0;
    this.dimX = shape[this.dim - 1];
    this.dimY = shape[this.dim - 2];
    this.dimC = 1;
    if (this.dim > 2) {
      this.dimC = this.shape[this.dim - 3];
    }
  }
  sizefromShape() {
    let size = 1;
    this.shape.forEach((value) => {
      size *= value;
    });
    return size;
  }
  add(value) {
    if (this.min === undefined) {
      this.min = value;
      this.max = value;
    }
    if (this.min > value) this.min = value;
    if (this.max < value) this.max = value;
    // if tensor is huge save values only
    if (this.dim > 2 || this.size > 10000) {
      this.values[this.i] = value;
    } else {
      this.values[this.i] = [
        this.i % this.shape[1],
        this.shape[0] - ((this.i / this.shape[1]) >> 0) - 1,
        value,
      ];
    }
    this.i++;
  }
  valueAt(c, x, y) {
    if (this.dim > 2 || this.size > 10000) {
      if (c >= this.dimC) {
        if (c == 3) {
          // Alpha channel
          var max = this.max;
          // for images
          if (max < 1 && this.min >= 0) {
            max = 1;
          }
          return max;
        }
        c = 0;
      }
      return this.values[y * this.dimX + x + c * this.dimY * this.dimX];
    } else {
      if (c == 3) {
        // Alpha channel
        var max = this.max;
        // for images
        if (max < 1 && this.min >= 0) {
          max = 1;
        }
        return max;
      }
      return this.values[y * this.dimX + x][2];
    }
  }
  get isCompleted() {
    return this.i === this.size;
  }
}

class SocketReader {
  constructor(maxLength=defaultMaxLength, setStateFunction=undefined) {
    this.ws_buffer = undefined;
    this.level = undefined;
    this.status = undefined;
    this.maxLength = maxLength;
    this.setStateFunction = setStateFunction;
  }

  concatTypedArrays(a, b) {
    // a, b TypedArray of same type
    var c = new a.constructor(a.length + b.length);
    c.set(a, 0);
    c.set(b, a.length);
    return c;
  }

  concatBuffers(a, b) {
    return this.concatTypedArrays(
      new Uint8Array(a.buffer || a),
      new Uint8Array(b.buffer || b)
    ).buffer;
  }

  //consume bytes from the global this.ws_buffer
  consumeBuffer(size) {
    if (this.ws_buffer && this.ws_buffer.byteLength >= size) {
      this.level = this.level - size;
      this.ws_buffer = this.ws_buffer.slice(size, this.ws_buffer.byteLength);
    }
  }

  // Uint8 view of part of global this.ws_buffer
  subUint8(size) {
    if (this.ws_buffer.byteLength >= this.level + size) {
      let view = new Uint8Array(this.ws_buffer, this.level, size);
      this.level = this.level + size;
      return view;
    }
  }

  // extract next value from global buffer as an Int8
  nextInt8() {
    if (this.ws_buffer.byteLength >= this.level + 1) {
      let res = new Int8Array(this.ws_buffer, this.level)[0];
      this.level = this.level + 1;
      return res;
    }
  }

  // return int64 littel endian encoded
  getInt64() {
    let buffer = this.subUint8(8);
    if (buffer != undefined) {
      let v = buffer[7];
      if (v > 127) {
        v = 256 - v;
        for (let i = 6; i >= 0; i = i - 1) {
          v = v * 256 - buffer[i];
        }
        v = -v;
      } else {
        for (let i = 6; i >= 0; i = i - 1) {
          v = v * 256 + buffer[i];
        }
      }
      this.status.length += +1;
      return v;
    }
  }

  // for Dec64 implementation see https://www.crockford.com/dec64.html
  getDec64() {
    let buffer = this.subUint8(8);
    if (buffer != undefined) {
      let v = buffer[7];
      // mantisse part
      if (v > 127) {
        v = 256 - v;
        for (let i = 6; i > 0; i = i - 1) {
          v = v * 256 - buffer[i];
        }
        v = -v;
      } else {
        for (let i = 6; i > 0; i = i - 1) {
          v = v * 256 + buffer[i];
        }
      }
      // exponent
      let e = buffer[0];
      if (e > 127) {
        // 10e- something
        v /= d64Factors[256 - e];
      } else {
        // 10e something
        v *= d64Factors[e];
      }
      this.status.length += +1;
      return v;
    }
  }

  // return Object ID
  // stored as an int in 3 bytes (24bits)
  getId() {
    let buffer = this.subUint8(3);
    if (buffer != undefined) {
      let v = 0;
      for (let i = 2; i >= 0; i = i - 1) {
        v = v * 256 + buffer[i];
      }
      return v;
    }
  }

  // return float 64
  // 8 bytes
  getFloat64() {
    if (this.ws_buffer.byteLength >= this.level + 8) {
      let res = new DataView(this.ws_buffer).getFloat64(this.level, true);
      this.level = this.level + 8;
      this.status.length += 1;
      return res;
    }
    return undefined;
  }

  // return Time UTC in ms
  getTime() {
    if (this.ws_buffer.byteLength >= this.level + 8) {
      return new Date(this.getInt64() / 1000000).toJSON();
    }
    return undefined;
  }

  // return Type Duration
  // wait for the next msg until buffer < 32
  getDuration() {
    if (this.ws_buffer.byteLength >= this.level + 32) {
      let res = {
        y: this.getInt64(),
        m: this.getInt64(),
        d: this.getInt64(),
        nano: this.getInt64(),
      };
      // make it a string
      let str = "";
      if (res.y != 0) {
        str = str.concat(res.y.toString(), "Y");
      }
      if (res.m != 0) {
        str = str.concat(res.y.toString(), "M");
      }
      if (res.d != 0) {
        str = str.concat(res.y.toString(), "D");
      }
      // Hours
      let sign = "";
      if (res.nano < 0) {
        res.nano = -res.nano;
        sign = "-";
      }
      let nano = Math.floor(res.nano / (60 * 60 * 1000000000));
      if (nano != 0) {
        str = str.concat(nano, "h");
      }
      res.nano = res.nano - nano * 60 * 60 * 1000000000;
      // Minutes
      nano = Math.floor(res.nano / (60 * 1000000000));
      if (nano != 0) {
        str = str.concat(nano, "m");
      }
      res.nano = res.nano - nano * 60 * 1000000000;
      // Seconds
      nano = res.nano / 1000000000;
      if (nano != 0) {
        str = str.concat(nano, "s");
      }
      if (str == "") {
        str = "0s";
      }
      this.status.length += -3;
      return sign.concat(str);
    }
    return undefined;
  }

  // check if size of string is received and the string
  // else get next message
  getString() {
    let size = this.getInt64();
    if (size != undefined) {
      let buf = this.subUint8(size);
      if (buf != undefined) {
        if (typeof TextDecoder === "undefined") {
          return String.fromCharCode.apply(null, buf);
        } else {
          this.status.length += 1;
          return new TextDecoder("utf-8").decode(buf);
        }
      }
    }
    return undefined;
  }

  niceformatter(v) {
    let nice = v.toString();
    if (typeof v === "number" && nice.length > 12) {
      nice = v.toPrecision(12).replace(/\.?0+$/, "");
    }
    return nice;
  }

  getResult(status) {
    let res = undefined;
    // check we have at least id&type and something
    if (this.ws_buffer.byteLength < this.level + 4 + 8) {
      return undefined;
    }
    let idtype = undefined;
    let id = undefined;
    // have we start to read a tensor?
    if (status.tensorbuf != undefined) {
      idtype = status.tensoridtype;
      id = status.tensorid;
    } else {
      idtype = this.nextInt8();
      id = this.getId();
    }
    if (idtype == undefined || id == undefined) {
      return undefined;
    }
    // are we in a timeserie ?
    let seriePos = status.serieIds.get(id);

    switch (idtype) {
      case TYPE.TInt:
        res = this.getInt64();
        break;
      case TYPE.TDec64:
        res = this.getDec64();
        break;
      case TYPE.TFloat:
        res = this.getFloat64();
        break;
      case TYPE.TTime:
        res = this.getTime();
        break;
      case TYPE.TDuration:
        res = this.getDuration();
        break;
      case TYPE.TError:
        res = this.getString();
        status.isError = true;
        // TODO : close socket
        break;
      case TYPE.TString:
        res = this.getString();
        break;
      case TYPE.TArray:
        // new array
        return this.getArrayHeader(status, id);
      case TYPE.TArraySerial:
        // serialized array read
        res = this.getSerialWsRes(idtype, status);
        break;
      case TYPE.TTimeSerie:
        return this.getTimeSerieLabel(status, id);
      case TYPE.TBool:
        res = false;
        if (this.getInt64() != 0) {
          res = true;
        }
        break;
      case TYPE.TPair:
        res = this.getPair(status);
        break;
      case TYPE.THeartBeat:
        res = this.getHeartBeat(status);
        // trick to continue until something else than HeartBeat
        return null;
      case TYPE.TTensor:
        status.tensorid = id;
        status.tensoridtype = idtype;
        res = this.getTensor(status);
        if (res != undefined) {
          // tensor should be put directly into graph
          let pos = 0;
          let arrayPos = status.arrayWhere.get(id);
          if (arrayPos != undefined) {
            pos = arrayPos.pos;
          }
          // TODO : to adapt according to new changes
        }
        break;
      case TYPE.TSentinel:
        if (this.getInt64() === 1) {
          // TODO : close socket -> socket.close();
        }
        break;
      default:
        console.log("Unhandled type N°" + idtype);
        return res;
    }
    // Tensor finished?
    if (status.tensorbuf != undefined) {
      return undefined;
    }
    if (seriePos == undefined) {
      //not in a timeserie
      // are we in an array ?
      let arrayPos = status.arrayWhere.get(id);
      if (arrayPos != undefined) {
        // set at the right position
        status.arrays.get(arrayPos.id)[arrayPos.pos] = res;
        return res;
      }
      if ((status.isError || id == 0) && res != undefined) {
        //simple result to put in status
        status.result = res;
      }
      return res;
    }
    // we are in a timeserie, retrieve time
    let time = this.getInt64();
    if (time === undefined) {
      return undefined;
    }
    time = time / 1000000;
    // are we in a timebar ?
    let tbPos = status.serieTbPos.get(id);
    if (tbPos == undefined) {
      // not part of a timebar
      if (time == -6795364578871.345152) {
        // go empty time have a UnixNano value of -6795364578871345152
        // timeserie with empty time, probably a // sample
        let lpos = status.datas[seriePos].length + 1;
        // if it is a pair, we have arguments
        if (res.length == 2) {
          status.datas[seriePos].push({
            value: [this.niceformatter(res[0]), res[1]],
          });
        } else {
          status.datas[seriePos].push({
            value: [this.niceformatter(lpos), res],
          });
        }
      } else {
        status.datas[seriePos].push({
          value: [time, res],
        });
      }
    } else {
      // timebar long enough ?
      if (status.datas[seriePos].length > tbPos) {
        // part of a timebar get where
        let arrayPos = status.arrayWhere.get(id);
        status.datas[seriePos][tbPos].value[arrayPos.pos * 2] = time;
        status.datas[seriePos][tbPos].value[arrayPos.pos * 2 + 1] = res;
      } else {
        // new point
        status.datas[seriePos].push({
          value: [time, res, time, res, time, res, time, res],
        });
      }
      // increment position
      status.serieTbPos.set(id, tbPos + 1);
    }
    return res;
  }

  // Element has been serialized as it is a point of a timeserie
  getSerialWsRes(idt, status, needArrayMap = true) {
    var res = undefined;
    // check we have at least something
    if (this.ws_buffer.byteLength < this.level + 8) {
      return undefined;
    }
    switch (idt) {
      case TYPE.TInt:
        res = this.getInt64();
        break;
      case TYPE.TDec64:
        res = this.getDec64();
        break;
      case TYPE.TFloat:
        res = this.getFloat64();
        break;
      case TYPE.TTime:
        res = this.getTime();
        break;
      case TYPE.TDuration:
        res = this.getDuration();
        break;
      case TYPE.TError:
        res = this.getString();
        status.isError = true;
        // TODO : close socket -> socket.close();
        break;
      case TYPE.TString:
        res = this.getString();
        break;
      case TYPE.TArray:
      case TYPE.TArraySerial:
        // Serialized array in a timeserie
        // read size
        var size = this.getInt64();
        if (size == undefined) {
          break;
        }
        if (size > this.maxLength / 2) {
          // TODO : close socket -> socket.close();
          break;
        }
        res = new Array(size);
        var lid = undefined;
        for (let index = 0; index < size; index++) {
          let lidtype = this.nextInt8();
          if (lidtype == undefined) {
            return undefined;
          }
          lid = this.getId();
          if (lid == undefined) {
            return undefined;
          }
          let result = this.getSerialWsRes(lidtype, status, needArrayMap);
          if (result == undefined) {
            return undefined;
          }
          res[index] = result;
        }
        if (needArrayMap) {
          status.arrays.set(lid, res);
        }
        break;
      case TYPE.TBool:
        res = false;
        if (this.getInt64() != 0) {
          res = true;
        }
        break;
      case TYPE.TPair:
        res = this.getPair(status);
        break;
      case TYPE.THeartBeat:
        // Should be unreachable
        res = this.getHeartBeat(status);
        break;
      case TYPE.TTensor:
        res = this.getTensor(status);
        break;
      default:
        // TODO : use debug variable ?
        if (false) {
          console.log("Unhandled type : " + idt);
        }
    }
    return res;
  }

  getTimeSerieLabel(status, id) {
    if (this.ws_buffer.byteLength < this.level + 4 + 8) {
      return undefined;
    }
    var label = this.getString();
    if (label == undefined) {
      return undefined;
    }
    // add new serie to ids labels and datas
    let pos = status.serieLabels.length;
    status.serieIds.set(id, pos);
    status.serieLabels.push(label);
    status.datas.push([]);
    // timeserie part of an array?
    let arrayPos = status.arrayWhere.get(id);
    if (arrayPos == undefined) {
      // not part of ana array
      return label;
    }
    // yes part of an array, but can it be a timebar?
    let isTb = status.tbArrays.get(arrayPos.id);
    if (isTb == undefined) {
      // not in a timebar
      return label;
    }
    // now look if all labels are the same
    let foundSame = 0;
    let array = status.arrays.get(arrayPos.id);
    for (let i = 0; i < array.length; i++) {
      // timeserie from loop number
      let lPos = status.serieIds.get(array[i]);
      let sLabel = status.serieLabels[lPos];
      if (sLabel == label) {
        foundSame++;
      }
    }
    if (foundSame != 4) {
      // not a time bar
      return label;
    }
    // This is a timebar
    status.tbArrays.set(arrayPos.id, true);
    // Need to fill data with previous ohlc
    for (let i = 0; i < array.length; i++) {
      // timeserie from loop number
      let lPos = status.serieIds.get(array[i]);
      if (lPos == pos) {
        // nothing todo this is timeserie currently being initialized
        status.serieTbPos.set(array[i], 0);
        continue;
      }
      let prevData = status.datas[lPos];
      for (let j = 0; j < prevData.length; j++) {
        let time = prevData[j].value[0];
        let res = prevData[j].value[1];
        if (status.datas[pos].length > j) {
          // just update ohlc part
          status.datas[pos][j].value[i * 2] = time;
          status.datas[pos][j].value[i * 2 + 1] = res;
        } else {
          // new point
          status.datas[pos].push({
            value: [time, res, time, res, time, res, time, res],
          });
        }
      }
      // erase old serie
      status.datas[lPos] = [];
      // redirect datas
      status.serieIds.set(array[i], pos);
      // set last point position
      status.serieTbPos.set(array[i], prevData.length);
    }
    return label;
  }

  getArrayHeader(status, id) {
    if (this.ws_buffer.byteLength < this.level + 8) {
      return undefined;
    }
    // read size of array
    let size = this.getInt64();
    if (size == undefined) {
      return undefined;
    }
    // each id&type is 4 bytes long
    if (this.ws_buffer.byteLength < this.level + size * 4) {
      return undefined;
    }
    status.arrays.set(id, new Array(size));
    // get all array elements ids at position
    let neededLabels = status.neededLabels;
    for (let i = 0; i < size; i++) {
      let lidtype = this.nextInt8();
      if (lidtype == undefined) {
        return undefined;
      }
      let lid = this.getId();
      if (lid == undefined) {
        return undefined;
      }
      if (lidtype == TYPE.TTimeSerie) {
        // this is a timeserie, we will need the label to graph it
        status.neededLabels++;
        // will be used to get position in timebar
        status.arrays.get(id)[i] = lid;
      }
      status.arrayWhere.set(lid, {
        id: id,
        pos: i,
      });
    }
    // Can it be a timebar? (open, high, low, close)
    if (size == 4 && status.neededLabels == neededLabels + 4) {
      // can be a timebar, if all labels are equals !
      status.tbArrays.set(id, false);
    }
    return size;
  }

  // recursively concat arrayis id of id
  getRank(status, id) {
    if (id == 0) {
      // main array
      return "0";
    }
    let idpos = status.arrayWhere.get(id);
    if (idpos == undefined) {
      return "";
    }
    return this.getRank(status, idpos.id).concat(idpos.pos.toString());
  }

  // pair of value
  getPair(status) {
    var res = new Array(2);
    for (let index = 0; index < 2; index++) {
      let lidtype = this.nextInt8();
      if (lidtype == undefined) {
        return undefined;
      }
      let lid = this.getId();
      if (lid == undefined) {
        return undefined;
      }
      res[index] = this.getSerialWsRes(lidtype, status, false);
      if (res[index] == undefined) {
        return undefined;
      }
    }
    return res;
  }

  // value for HeartBeat
  getHeartBeat(status) {
    // check we have at least id&type and something
    if (this.ws_buffer.byteLength < this.level + 4 + 8) {
      return undefined;
    }
    // HeartBeat should have no impact on length as it is not kept
    // subsctract 1 for HeartBeat ID
    let length = this.status.length - 1;
    let idtype = this.nextInt8();
    let id = this.getId();
    if (idtype == undefined || id == undefined) {
      return undefined;
    }
    let res = this.getSerialWsRes(idtype, status, false);
    if (res != undefined) {
      // forget HeartBeat length!
      this.status.length = length;
    }
    return res;
  }

  // Tensor is a list of dimentions and serialized values
  getTensor(status) {
    // reading already started?
    var tensor = undefined;
    if (status.tensorbuf != undefined) {
      tensor = status.tensorbuf;
    } else {
      if (this.ws_buffer.byteLength < this.level + 4 + 8) {
        // check we have at least id&type and something
        return undefined;
      }
      // Read 4 (useless id)
      // Get tensor shape :
      let idtypeShape = this.nextInt8();
      // forget id
      this.level = this.level + 3;
      if (idtypeShape != TYPE.TArraySerial) {
        console.error("Tensor should start by a shape definition");
        return undefined;
      }

      let shape = this.getSerialWsRes(idtypeShape, status, false);
      tensor = new Tensor(shape);
    }
    // Get tensor Values :
    var toConsume = this.level;
    do {
      let value = undefined;
      let idtype = undefined;
      if (this.ws_buffer.byteLength > this.level + 4) {
        // check we have at least id&type
        idtype = this.nextInt8();
        // forget id
        this.level = this.level + 3;
        value = this.getSerialWsRes(idtype, status, false);
      }
      if (value === undefined) {
        this.consumeBuffer(toConsume);
        // not enough value in buffered message
        status.tensorbuf = tensor;
        return undefined;
      }
      tensor.add(value);
      toConsume = this.level;
    } while (!tensor.isCompleted);
    this.consumeBuffer(this.level);
    delete status.tensorbuf;
    return tensor;
  }

  consumeResult() {
    let result, tmp_level, tmp_length;
    do {
      tmp_level = this.level;
      tmp_length = this.status.length;
      result = this.getResult(this.status);
      
      // set state
      // TODO : manage result
      this.setStateFunction({ items: this.status.datas?.[0] || [] });

      if (result !== undefined) {
        this.consumeBuffer(this.level);
        if (this.status.isError) {
          // early stop on error
          return false;
        }
      } else {
        this.status.length = tmp_length;
        this.level = tmp_level;
      }
      // this is an HeartBeat
      if (result === null) return true;
    } while (result !== undefined);
    return result === null;
  };
}

module.exports = {
  defaultMaxLength,
  TYPE,
  SocketReader,
  Tensor,
};
