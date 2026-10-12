// Bluetooth Thermal Printer Helper for Mobile (Web Bluetooth API)
// Compatible with Liotog, Fun Print, Xprinter, and generic ESC/POS / BLE thermal printers.

const COMMON_SERVICES = [
  '0000fee7-0000-1000-8000-00805f9b34fb', // Very common for Fun Print / C9 / WalkPrint / GB01
  '0000ffe0-0000-1000-8000-00805f9b34fb', // Standard HM-10 / Nordic serial BLE
  '000018f0-0000-1000-8000-00805f9b34fb', // Standard POS thermal printer
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC transparent UART
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2'  // Broadcom / Jerry BLE
];

/**
 * Request and connect to nearby Bluetooth Thermal Printer
 */
export async function connectBluetoothPrinter() {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth is not supported on this browser. On Android, please use Chrome. On iPhone, use the WebBLE browser app.');
  }

  // Request device
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: COMMON_SERVICES
  });

  if (!device.gatt) {
    throw new Error('Bluetooth GATT not available on this device.');
  }

  const server = await device.gatt.connect();

  // Dynamically find the primary service and writable characteristic
  let writeCharacteristic = null;
  const services = await server.getPrimaryServices();

  for (const service of services) {
    try {
      const characteristics = await service.getCharacteristics();
      for (const char of characteristics) {
        if (char.properties.write || char.properties.writeWithoutResponse) {
          writeCharacteristic = char;
          break;
        }
      }
      if (writeCharacteristic) break;
    } catch (e) {
      // Continue search on other services
    }
  }

  if (!writeCharacteristic) {
    throw new Error('Could not find a writable print channel on this Bluetooth device.');
  }

  return {
    device,
    characteristic: writeCharacteristic,
    name: device.name || 'Bluetooth Printer'
  };
}

/**
 * Disconnects from the Bluetooth printer
 */
export function disconnectBluetoothPrinter(device) {
  if (device && device.gatt && device.gatt.connected) {
    device.gatt.disconnect();
  }
}

/**
 * Helper to split byte buffer into safe BLE MTU chunks (<= 60 bytes)
 */
async function sendChunks(characteristic, data) {
  const CHUNK_SIZE = 60;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.slice(i, i + CHUNK_SIZE);
    if (characteristic.properties.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(chunk);
    } else {
      await characteristic.writeValue(chunk);
    }
    // Short pause between chunks for printer buffer
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * Encodes text string to ASCII / CP437 Uint8Array
 */
function encodeText(str) {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

/**
 * Builds standard ESC/POS commands for order sticker
 */
export async function printInvoiceBluetooth(characteristic, order) {
  if (!characteristic) throw new Error('Bluetooth printer is not connected.');

  const encoder = new TextEncoder();
  const ESC = 0x1B;
  const GS = 0x1D;

  // ESC/POS Command Sequence:
  // 1. Initialize: ESC @ [0x1B, 0x40]
  // 2. Center Align: ESC a 1 [0x1B, 0x61, 0x01]
  // 3. Double-height header: GS ! 0x11 [0x1D, 0x21, 0x11]
  const initCmds = new Uint8Array([ESC, 0x40, ESC, 0x61, 0x01]);
  const header = encoder.encode("PAWFIT DESK\nINVOICE\n");
  const divider = encoder.encode("--------------------------------\n");

  // Left align for details
  const leftAlign = new Uint8Array([ESC, 0x61, 0x00]);
  const details = encoder.encode(
    `Buyer: ${order.name || 'Anonymous'}\n` +
    `User:  ${order.username || ''}\n` +
    `Time:  ${order.time || ''}\n`
  );

  // Bold on: ESC E 1 [0x1B, 0x45, 0x01]
  // Large item code & amount: GS ! 0x11
  const boldOn = new Uint8Array([ESC, 0x45, 0x01, GS, 0x21, 0x11]);
  const itemInfo = encoder.encode(
    `ITEM:  ${order.code}\n` +
    `PRICE: P${order.amount}\n`
  );
  // Bold off: ESC E 0, normal size: GS ! 0x00
  const boldOff = new Uint8Array([ESC, 0x45, 0x00, GS, 0x21, 0x00]);

  const footer = encoder.encode("--------------------------------\nThank you for shopping!\n");
  // Feed 4 lines: ESC d 4
  const feedCmd = new Uint8Array([ESC, 0x64, 0x04]);

  // Combine all parts
  const fullPayload = concatenateUint8Arrays([
    initCmds,
    header,
    divider,
    leftAlign,
    details,
    boldOn,
    itemInfo,
    boldOff,
    footer,
    feedCmd
  ]);

  await sendChunks(characteristic, fullPayload);
}

/**
 * Print a quick test receipt
 */
export async function testPrintBluetooth(characteristic) {
  if (!characteristic) throw new Error('Bluetooth printer is not connected.');

  const encoder = new TextEncoder();
  const ESC = 0x1B;

  const initCmds = new Uint8Array([ESC, 0x40, ESC, 0x61, 0x01]);
  const text = encoder.encode("PAWFIT DESK\nBluetooth Printer Connected!\nReady for Live Selling!\n\n\n\n");
  const feedCmd = new Uint8Array([ESC, 0x64, 0x03]);

  const payload = concatenateUint8Arrays([initCmds, text, feedCmd]);
  await sendChunks(characteristic, payload);
}

function concatenateUint8Arrays(arrays) {
  let totalLength = arrays.reduce((acc, curr) => acc + curr.length, 0);
  let result = new Uint8Array(totalLength);
  let offset = 0;
  for (let arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
