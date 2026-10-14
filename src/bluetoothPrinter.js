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
export async function printInvoice(printer, order, settings = {}) {
  if (!printer) throw new Error('Bluetooth printer is not connected.');

  if (printer.type === 'niimbot') {
    return printInvoiceNiimbot(printer.client, order, settings);
  } else if (printer.type === 'escpos') {
    return printInvoiceEscPos(printer.characteristic, order, settings);
  } else if (printer.characteristic) {
    // Backward compatibility if raw characteristic passed
    return printInvoiceEscPos(printer.characteristic, order, settings);
  } else {
    throw new Error('Unknown printer type.');
  }
}

/**
 * Unified Test Print Function
 */
export async function printTest(printer, settings = {}) {
  if (!printer) throw new Error('Bluetooth printer is not connected.');

  if (printer.type === 'niimbot') {
    return testPrintNiimbot(printer.client, settings);
  } else if (printer.type === 'escpos') {
    return testPrintEscPos(printer.characteristic, settings);
  } else if (printer.characteristic) {
    return testPrintEscPos(printer.characteristic, settings);
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
 * Prints a customizable label sticker on NIIMBOT B1 / B1 Pro / B21 / D110
 */
export async function printInvoiceNiimbot(client, order, settings = {}) {
  if (!client || !client.isConnected()) {
    throw new Error('NIIMBOT printer is not connected.');
  }

  const {
    storeName = 'PAWFIT CLOSET',
    showStoreName = true,
    showBuyerName = true,
    showUsername = true,
    showTime = true,
    showCode = true,
    showPrice = true,
    showFooter = true,
    footerText = 'Thank you for shopping! TikTok Live'
  } = settings;

  const meta = client.getModelMetadata();
  const printheadPixels = meta?.printheadPixels || 384;
  const scale = printheadPixels / 384;
  const width = printheadPixels;
  const height = Math.round(300 * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';

  // ── 1. Header: Store Name ───────────────────────────────────────────────────
  if (showStoreName && storeName.trim()) {
    ctx.textAlign = 'center';
    autoFitText(ctx, storeName.trim().toUpperCase(), 'bold', 18, scale, width - Math.round(30 * scale));
    ctx.fillText(storeName.trim().toUpperCase(), width / 2, Math.round(25 * scale));

    ctx.lineWidth = Math.round(2.5 * scale);
    ctx.beginPath();
    ctx.moveTo(Math.round(8 * scale), Math.round(35 * scale));
    ctx.lineTo(width - Math.round(8 * scale), Math.round(35 * scale));
    ctx.stroke();
  }

  // ── 2. Buyer Name ─────────────────────────────────────────────────────────────
  const padL = Math.round(14 * scale);
  const maxW = width - Math.round(28 * scale);

  if (showBuyerName) {
    ctx.textAlign = 'left';
    const buyerLabel = 'Buyer: ';
    const buyerName = order.name || 'Anonymous';
    const fullBuyer = `${buyerLabel}${buyerName}`;
    autoFitText(ctx, fullBuyer, 'normal', 32, scale, maxW);
    ctx.fillText(fullBuyer, padL, Math.round(65 * scale));
  }

  // ── 3. Username & 4. Time ─────────────────────────────────────────────────────
  const username = (order.username || '').replace(/^@+/, '');
  const displayUser = username ? `@${username}` : '';
  if (showUsername && displayUser) {
    ctx.textAlign = 'left';
    autoFitText(ctx, displayUser, 'normal', 18, scale, maxW - Math.round(70 * scale));
    ctx.fillText(displayUser, padL, Math.round(100 * scale));
  }

  if (showTime) {
    const orderTime = order.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.textAlign = 'right';
    ctx.font = `normal ${Math.round(11 * scale)}px Arial, Helvetica, sans-serif`;
    ctx.fillText(orderTime, width - Math.round(12 * scale), Math.round(100 * scale));
    ctx.textAlign = 'left';
  }

  // ── 5. Rounded box for CODE & PRICE ──────────────────────────────────────────
  if (showCode || showPrice) {
    ctx.lineWidth = Math.round(2 * scale);
    const boxX = Math.round(8 * scale);
    const boxY = Math.round(115 * scale);
    const boxW = width - Math.round(16 * scale);
    const boxH = Math.round(70 * scale);  // box bottom = 185
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

    // Both code and price, or single line centered
    if (showCode && showPrice) {
      // CODE row
      ctx.font = `bold ${Math.round(13 * scale)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('CODE', Math.round(22 * scale), boxY + Math.round(22 * scale));
      autoFitText(ctx, String(order.code), 'bold', 22, scale, boxW - Math.round(80 * scale));
      ctx.fillText(String(order.code), Math.round(84 * scale), boxY + Math.round(22 * scale));

      // PRICE row
      ctx.font = `bold ${Math.round(13 * scale)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('PRICE', Math.round(22 * scale), boxY + Math.round(54 * scale));
      ctx.font = `bold ${Math.round(22 * scale)}px Arial, Helvetica, sans-serif`;
      ctx.fillText(`P${order.amount}`, Math.round(84 * scale), boxY + Math.round(54 * scale));
    } else if (showCode) {
      ctx.font = `bold ${Math.round(15 * scale)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('CODE', Math.round(22 * scale), boxY + Math.round(40 * scale));
      autoFitText(ctx, String(order.code), 'bold', 24, scale, boxW - Math.round(80 * scale));
      ctx.fillText(String(order.code), Math.round(84 * scale), boxY + Math.round(40 * scale));
    } else if (showPrice) {
      ctx.font = `bold ${Math.round(15 * scale)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('PRICE', Math.round(22 * scale), boxY + Math.round(40 * scale));
      ctx.font = `bold ${Math.round(24 * scale)}px Arial, Helvetica, sans-serif`;
      ctx.fillText(`P${order.amount}`, Math.round(84 * scale), boxY + Math.round(40 * scale));
    }
  }

  // ── 6. Footer ────────────────────────────────────────────────────────────────
  if (showFooter && footerText.trim()) {
    const footerLineY = Math.round(200 * scale);
    const footerY     = Math.round(215 * scale);

    ctx.lineWidth = Math.round(1.5 * scale);
    ctx.beginPath();
    ctx.moveTo(Math.round(8 * scale), footerLineY);
    ctx.lineTo(width - Math.round(8 * scale), footerLineY);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = `normal ${Math.round(10 * scale)}px Arial, Helvetica, sans-serif`;
    ctx.fillText(footerText.trim(), width / 2, footerY);
  }

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
export async function testPrintNiimbot(client, settings = {}) {
  if (!client || !client.isConnected()) {
    throw new Error('NIIMBOT printer is not connected.');
  }

  const storeName = settings.storeName || 'PAWFIT DESK';
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
  autoFitText(ctx, storeName.toUpperCase(), 'bold', 20, scale, width - Math.round(24 * scale));
  ctx.fillText(storeName.toUpperCase(), width / 2, Math.round(24 * scale));

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

export async function printInvoiceEscPos(characteristic, order, settings = {}) {
  if (!characteristic) throw new Error('Bluetooth printer is not connected.');

  const {
    storeName = 'PAWFIT DESK',
    showStoreName = true,
    showBuyerName = true,
    showUsername = true,
    showTime = true,
    showCode = true,
    showPrice = true,
    showFooter = true,
    footerText = 'Thank you for shopping!\n'
  } = settings;

  const encoder = new TextEncoder();
  const ESC = 0x1B;
  const GS = 0x1D;

  const parts = [];

  const initCmds = new Uint8Array([ESC, 0x40, ESC, 0x61, 0x01]);
  parts.push(initCmds);

  if (showStoreName && storeName.trim()) {
    parts.push(encoder.encode(`${storeName.trim().toUpperCase()}\nINVOICE\n--------------------------------\n`));
  }

  const leftAlign = new Uint8Array([ESC, 0x61, 0x00]);
  parts.push(leftAlign);

  const boldOn = new Uint8Array([ESC, 0x45, 0x01]);
  const boldOff = new Uint8Array([ESC, 0x45, 0x00]);

  let buyerText = '';
  if (showBuyerName) buyerText += `BUYER: ${order.name || 'Anonymous'}\n`;
  if (showUsername) buyerText += `USER:  ${order.username || ''}\n`;
  if (showTime) buyerText += `TIME:  ${order.time || ''}\n`;

  if (buyerText) {
    parts.push(boldOn, encoder.encode(buyerText), boldOff);
  }

  let codePriceText = '';
  if (showCode) codePriceText += `CODE:  ${order.code}\n`;
  if (showPrice) codePriceText += `PRICE: P${order.amount}\n`;

  if (codePriceText) {
    const bigFontOn = new Uint8Array([ESC, 0x45, 0x01, GS, 0x21, 0x11]);
    const bigFontOff = new Uint8Array([ESC, 0x45, 0x00, GS, 0x21, 0x00]);
    parts.push(bigFontOn, encoder.encode(codePriceText), bigFontOff);
  }

  if (showFooter && footerText.trim()) {
    parts.push(encoder.encode(`--------------------------------\n${footerText.trim()}\n`));
  }

  const feedCmd = new Uint8Array([ESC, 0x64, 0x04]);
  parts.push(feedCmd);

  const fullPayload = concatenateUint8Arrays(parts);
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
