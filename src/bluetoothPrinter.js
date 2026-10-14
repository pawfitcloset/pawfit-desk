// Bluetooth Thermal Printer Helper for Mobile (Web Bluetooth API)
// Full native support for NIIMBOT printers (B1, B1 Pro, B21, D110, etc.) via @mmote/niimbluelib
// AND generic ESC/POS / BLE thermal printers (Liotog, Fun Print, Xprinter BLE).

import {
  NiimbotBluetoothClient,
  ImageEncoder,
  PageColorType,
  LabelType
} from '@mmote/niimbluelib';

const COMMON_SERVICES = [
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Niimbot Primary Service
  '0000fee7-0000-1000-8000-00805f9b34fb', // Fun Print / C9 / WalkPrint / GB01 / Liotog
  '0000ffe0-0000-1000-8000-00805f9b34fb', // Standard HM-10 / Nordic serial BLE
  '000018f0-0000-1000-8000-00805f9b34fb', // Standard POS thermal printer
  '49535343-fe7d-4ae5-8fa9-9fafd205e455'  // ISSC transparent UART
];

/**
 * Request and connect to nearby Bluetooth Thermal Printer
 * Supports both NIIMBOT (B1, B1 Pro, B21, etc.) and generic ESC/POS BLE printers.
 */
export async function connectBluetoothPrinter(onDisconnect) {
  if (!navigator.bluetooth) {
    throw new Error(
      'Web Bluetooth is not supported on this browser.\n' +
      '• On Android: Open Chrome and ensure you use HTTPS (e.g. https://...).\n' +
      '• On iPhone: Use the WebBLE or Bluefy browser app.'
    );
  }

  // Request device dialog
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: COMMON_SERVICES
  });

  if (!device) {
    throw new Error('No device selected.');
  }

  const deviceName = device.name || 'Bluetooth Printer';
  const isNiimbot = /niimbot|b1|b21|b3s|d11|d110|b203|jc/i.test(deviceName);

  // ─── 1. Attempt NIIMBOT connection first if name matches or fallback ───
  if (isNiimbot) {
    try {
      console.log(`[Bluetooth] Attempting Niimbot connection to "${deviceName}"...`);
      const client = new NiimbotBluetoothClient();
      await client.connect({ authorizedDevice: device });

      client.on('disconnect', () => {
        console.warn('[Bluetooth] Niimbot printer disconnected.');
        if (onDisconnect) onDisconnect();
      });

      const meta = client.getModelMetadata();
      console.log('[Bluetooth] Niimbot connected successfully:', meta);

      return {
        type: 'niimbot',
        client,
        device,
        name: deviceName,
        model: meta?.model || 'NIIMBOT B1 Pro',
        meta
      };
    } catch (niimErr) {
      console.warn('[Bluetooth] Niimbot protocol connect failed, falling back to ESC/POS:', niimErr.message);
    }
  }

  // ─── 2. Connect via Standard ESC/POS GATT ──────────────────────────────
  if (!device.gatt) {
    throw new Error('Bluetooth GATT not available on this device.');
  }

  const server = await device.gatt.connect();

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
    // If not found in standard services, try Niimbot protocol as last resort
    try {
      const client = new NiimbotBluetoothClient();
      await client.connect({ authorizedDevice: device });
      const meta = client.getModelMetadata();
      return {
        type: 'niimbot',
        client,
        device,
        name: deviceName,
        model: meta?.model || 'NIIMBOT B1 Pro',
        meta
      };
    } catch {
      throw new Error('Could not find a writable print channel on this Bluetooth device.');
    }
  }

  device.addEventListener('gattserverdisconnected', () => {
    console.warn('[Bluetooth] ESC/POS printer disconnected.');
    if (onDisconnect) onDisconnect();
  });

  return {
    type: 'escpos',
    device,
    characteristic: writeCharacteristic,
    name: deviceName,
    model: 'ESC/POS Printer'
  };
}

/**
 * Disconnects from the Bluetooth printer
 */
export async function disconnectBluetoothPrinter(printer) {
  if (!printer) return;
  try {
    if (printer.type === 'niimbot' && printer.client) {
      await printer.client.disconnect();
    } else if (printer.device?.gatt?.connected) {
      printer.device.gatt.disconnect();
    }
  } catch (err) {
    console.warn('[Bluetooth] Error disconnecting:', err.message);
  }
}

/**
 * Unified Print Invoice Function
 * Automatically routes to Niimbot protocol or ESC/POS based on printer type.
 */
export async function printInvoice(printer, order) {
  if (!printer) throw new Error('Bluetooth printer is not connected.');

  if (printer.type === 'niimbot') {
    return printInvoiceNiimbot(printer.client, order);
  } else if (printer.type === 'escpos') {
    return printInvoiceEscPos(printer.characteristic, order);
  } else if (printer.characteristic) {
    // Backward compatibility if raw characteristic passed
    return printInvoiceEscPos(printer.characteristic, order);
  } else {
    throw new Error('Unknown printer type.');
  }
}

/**
 * Unified Test Print Function
 */
export async function printTest(printer) {
  if (!printer) throw new Error('Bluetooth printer is not connected.');

  if (printer.type === 'niimbot') {
    return testPrintNiimbot(printer.client);
  } else if (printer.type === 'escpos') {
    return testPrintEscPos(printer.characteristic);
  } else if (printer.characteristic) {
    return testPrintEscPos(printer.characteristic);
  } else {
    throw new Error('Unknown printer type.');
  }
}

// ─── NIIMBOT Specific Printing ────────────────────────────────────────────────

/**
 * Auto-fit text within maxWidth — shrinks font size until it fits.
 * Returns the final pixel size used.
 */
function autoFitText(ctx, text, fontStyle, baseSize, scale, maxWidth) {
  let size = baseSize;
  ctx.font = `${fontStyle} ${Math.round(size * scale)}px Arial, Helvetica, sans-serif`;
  while (ctx.measureText(text).width > maxWidth && size > 9) {
    size -= 1;
    ctx.font = `${fontStyle} ${Math.round(size * scale)}px Arial, Helvetica, sans-serif`;
  }
  return size;
}

/**
 * Prints a high-resolution label sticker on NIIMBOT B1 / B1 Pro / B21 / D110
 *
 * Layout:
 *   ┌──────────────────────────────────┐
 *   │        PAWFIT CLOSET             │
 *   ├──────────────────────────────────┤
 *   │  Buyer: Maria Santos             │  ← large, not bold
 *   │  @mariasantos          10:35 AM  │  ← username, time right-aligned
 *   ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
 *   │ ╭──────────────────────────────╮ │
 *   │ │ CODE    23                   │ │
 *   │ │ PRICE   P129                 │ │
 *   │ ╰──────────────────────────────╯ │
 *   ├──────────────────────────────────┤
 *   │      Thank you for shopping!     │
 *   └──────────────────────────────────┘
 */
export async function printInvoiceNiimbot(client, order) {
  if (!client || !client.isConnected()) {
    throw new Error('NIIMBOT printer is not connected.');
  }

  const meta = client.getModelMetadata();
  const printheadPixels = meta?.printheadPixels || 384;
  const scale = printheadPixels / 384;
  const width = printheadPixels;
  const height = Math.round(215 * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';

  // ── 1. Header: PAWFIT CLOSET ─────────────────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.font = `bold ${Math.round(18 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText('PAWFIT CLOSET', width / 2, Math.round(23 * scale));

  ctx.lineWidth = Math.round(2.5 * scale);
  ctx.beginPath();
  ctx.moveTo(Math.round(8 * scale), Math.round(31 * scale));
  ctx.lineTo(width - Math.round(8 * scale), Math.round(31 * scale));
  ctx.stroke();

  // ── 2. Buyer Name — large, not bold, with "Buyer:" prefix ────────────────────
  ctx.textAlign = 'left';
  const padL = Math.round(14 * scale);
  const maxW = width - Math.round(28 * scale);

  const buyerLabel = 'Buyer: ';
  const buyerName = order.name || 'Anonymous';
  const fullBuyer = `${buyerLabel}${buyerName}`;
  autoFitText(ctx, fullBuyer, 'normal', 26, scale, maxW);
  ctx.fillText(fullBuyer, padL, Math.round(58 * scale));

  // ── 3. Username — large, not bold ────────────────────────────────────────────
  const username = (order.username || '').replace(/^@+/, '');
  const displayUser = username ? `@${username}` : '';
  if (displayUser) {
    autoFitText(ctx, displayUser, 'normal', 18, scale, maxW - Math.round(60 * scale));
    ctx.fillText(displayUser, padL, Math.round(82 * scale));
  }

  // ── 4. Time — small, right-aligned ───────────────────────────────────────────
  const orderTime = order.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  ctx.textAlign = 'right';
  ctx.font = `normal ${Math.round(11 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText(orderTime, width - Math.round(12 * scale), Math.round(82 * scale));
  ctx.textAlign = 'left';

  // ── Dashed divider ───────────────────────────────────────────────────────────
  ctx.lineWidth = Math.round(1 * scale);
  ctx.setLineDash([Math.round(4 * scale), Math.round(3 * scale)]);
  ctx.beginPath();
  ctx.moveTo(Math.round(8 * scale), Math.round(96 * scale));
  ctx.lineTo(width - Math.round(8 * scale), Math.round(96 * scale));
  ctx.stroke();
  ctx.setLineDash([]);

  // ── 5. Rounded box for CODE & PRICE (compact, no inner divider) ──────────────
  ctx.lineWidth = Math.round(2 * scale);
  const boxX = Math.round(8 * scale);
  const boxY = Math.round(104 * scale);
  const boxW = width - Math.round(16 * scale);
  const boxH = Math.round(72 * scale);   // smaller box
  const r = Math.round(6 * scale);

  ctx.beginPath();
  ctx.moveTo(boxX + r, boxY);
  ctx.lineTo(boxX + boxW - r, boxY);
  ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + r, r);
  ctx.lineTo(boxX + boxW, boxY + boxH - r);
  ctx.arcTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH, r);
  ctx.lineTo(boxX + r, boxY + boxH);
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY + boxH - r, r);
  ctx.lineTo(boxX, boxY + r);
  ctx.arcTo(boxX, boxY, boxX + r, boxY, r);
  ctx.closePath();
  ctx.stroke();

  // CODE row
  ctx.font = `bold ${Math.round(13 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText('CODE', Math.round(22 * scale), boxY + Math.round(22 * scale));
  autoFitText(ctx, String(order.code), 'bold', 22, scale, boxW - Math.round(80 * scale));
  ctx.fillText(String(order.code), Math.round(84 * scale), boxY + Math.round(22 * scale));

  // PRICE row (no divider line between)
  ctx.font = `bold ${Math.round(13 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText('PRICE', Math.round(22 * scale), boxY + Math.round(54 * scale));
  ctx.font = `bold ${Math.round(22 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText(`P${order.amount}`, Math.round(84 * scale), boxY + Math.round(54 * scale));

  // ── 6. Footer ────────────────────────────────────────────────────────────────
  const footerY = Math.round(205 * scale);

  ctx.lineWidth = Math.round(1.5 * scale);
  ctx.beginPath();
  ctx.moveTo(Math.round(8 * scale), Math.round(195 * scale));
  ctx.lineTo(width - Math.round(8 * scale), Math.round(195 * scale));
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = `normal ${Math.round(10 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText('Thank you for shopping! TikTok Live', width / 2, footerY);

  // ── Encode & Send to Printer ─────────────────────────────────────────────────
  const encodedImage = ImageEncoder.encodeCanvas(
    canvas,
    PageColorType.SingleColor,
    meta?.printDirection || 'top'
  );

  const taskType = client.getPrintTaskType() || 'B1';
  const printTask = client.protocol.newPrintTask(taskType, {
    totalPages: 1,
    density: 5,
    labelType: LabelType.WithGaps
  });

  try {
    await printTask.printInit();
    await printTask.printPage(encodedImage, 1);
    await printTask.waitForPageFinished();
    await printTask.waitForFinished();
  } finally {
    await printTask.printEnd();
  }
}

/**
 * Print a quick test label on NIIMBOT B1 / B1 Pro
 */
export async function testPrintNiimbot(client) {
  if (!client || !client.isConnected()) {
    throw new Error('NIIMBOT printer is not connected.');
  }

  const meta = client.getModelMetadata();
  const printheadPixels = meta?.printheadPixels || 384;
  const scale = printheadPixels / 384;
  const width = printheadPixels;
  const height = Math.round(220 * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';

  // Header title
  ctx.textAlign = 'center';
  ctx.font = `bold ${Math.round(20 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText('PAWFIT DESK', width / 2, Math.round(24 * scale));

  ctx.lineWidth = Math.round(2 * scale);
  ctx.beginPath();
  ctx.moveTo(Math.round(12 * scale), Math.round(32 * scale));
  ctx.lineTo(width - Math.round(12 * scale), Math.round(32 * scale));
  ctx.stroke();



  ctx.font = `bold ${Math.round(14 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText(`${meta?.model || 'NIIMBOT B1 PRO'} CONNECTED ✓`, width / 2, Math.round(122 * scale));

  ctx.font = `normal ${Math.round(12 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText('Bluetooth printing is READY!', width / 2, Math.round(144 * scale));

  ctx.font = `normal ${Math.round(11 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText('Auto-prints when comments are pinned!', width / 2, Math.round(163 * scale));

  ctx.lineWidth = Math.round(1 * scale);
  ctx.beginPath();
  ctx.moveTo(Math.round(20 * scale), Math.round(174 * scale));
  ctx.lineTo(width - Math.round(20 * scale), Math.round(174 * scale));
  ctx.stroke();

  const now = new Date().toLocaleString('en-PH');
  ctx.font = `normal ${Math.round(10 * scale)}px Arial, Helvetica, sans-serif`;
  ctx.fillText(now, width / 2, Math.round(193 * scale));

  const encodedImage = ImageEncoder.encodeCanvas(
    canvas,
    PageColorType.SingleColor,
    meta?.printDirection || 'top'
  );

  const taskType = client.getPrintTaskType() || 'B1';
  const printTask = client.protocol.newPrintTask(taskType, {
    totalPages: 1,
    density: 5,
    labelType: LabelType.WithGaps
  });

  try {
    await printTask.printInit();
    await printTask.printPage(encodedImage, 1);
    await printTask.waitForPageFinished();
    await printTask.waitForFinished();
  } finally {
    await printTask.printEnd();
  }
}

// ─── ESC/POS Generic Thermal Printing ─────────────────────────────────────────

async function sendChunks(characteristic, data) {
  const CHUNK_SIZE = 60;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.slice(i, i + CHUNK_SIZE);
    if (characteristic.properties.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(chunk);
    } else {
      await characteristic.writeValue(chunk);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function printInvoiceEscPos(characteristic, order) {
  if (!characteristic) throw new Error('Bluetooth printer is not connected.');

  const encoder = new TextEncoder();
  const ESC = 0x1B;
  const GS = 0x1D;

  const initCmds = new Uint8Array([ESC, 0x40, ESC, 0x61, 0x01]);
  const header = encoder.encode("PAWFIT DESK\nINVOICE\n");
  const divider = encoder.encode("--------------------------------\n");

  const leftAlign = new Uint8Array([ESC, 0x61, 0x00]);

  // Bold Buyer and Username details
  const boldOn = new Uint8Array([ESC, 0x45, 0x01]);
  const boldOff = new Uint8Array([ESC, 0x45, 0x00]);
  const buyerDetails = encoder.encode(
    `BUYER: ${order.name || 'Anonymous'}\n` +
    `USER:  ${order.username || ''}\n` +
    `TIME:  ${order.time || ''}\n`
  );

  // Large Bold CODE and PRICE
  const bigFontOn = new Uint8Array([ESC, 0x45, 0x01, GS, 0x21, 0x11]);
  const codeInfo = encoder.encode(
    `CODE:  ${order.code}\n` +
    `PRICE: P${order.amount}\n`
  );
  const bigFontOff = new Uint8Array([ESC, 0x45, 0x00, GS, 0x21, 0x00]);

  const footer = encoder.encode("--------------------------------\nThank you for shopping!\n");
  const feedCmd = new Uint8Array([ESC, 0x64, 0x04]);

  const fullPayload = concatenateUint8Arrays([
    initCmds,
    header,
    divider,
    leftAlign,
    boldOn,
    buyerDetails,
    boldOff,
    bigFontOn,
    codeInfo,
    bigFontOff,
    footer,
    feedCmd
  ]);

  await sendChunks(characteristic, fullPayload);
}

export async function testPrintEscPos(characteristic) {
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

// Aliases for backwards compatibility
export const printInvoiceBluetooth = printInvoice;
export const testPrintBluetooth = printTest;
