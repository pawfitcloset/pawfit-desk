import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Play, 
  Square, 
  RefreshCw, 
  Printer, 
  Search, 
  Lock, 
  Unlock, 
  Trash2, 
  CheckCircle2, 
  Clock, 
  PackageSearch,
  Pin,
  Sheet,
  Wifi,
  WifiOff,
  ExternalLink,
  RefreshCcw,
  LogOut,
  MessageSquare,
  ShoppingBag,
  Bluetooth,
  X,
  Link2,
  HelpCircle
} from 'lucide-react';
import { io } from 'socket.io-client';
import { 
  connectBluetoothPrinter, 
  disconnectBluetoothPrinter, 
  printInvoice, 
  printTest 
} from './bluetoothPrinter';

const API_URL = import.meta.env.VITE_API_URL || '';
const socket = io(API_URL || undefined, {
  autoConnect: false
});

export default function PawfitDesk() {
  const [isLive, setIsLive] = useState(false);
  const [targetUsername, setTargetUsername] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('offline');
  
  const [comments, setComments] = useState([]);
  const [orders, setOrders] = useState([]);
  const [lockedCodes, setLockedCodes] = useState([]);
  const [dpRecords, setDpRecords] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [printToast, setPrintToast] = useState(null);
  const [currentTime, setCurrentTime] = useState(new Date().toLocaleTimeString());
  const [mobileTab, setMobileTab] = useState('chat'); // 'chat' | 'pouches'
  
  // ── Google Sheets state ──────────────────────────────────────────────────────
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleUser, setGoogleUser]           = useState(null); // { name, email, picture }
  const [sheetUrl, setSheetUrl] = useState(null);
  const [sheetSyncing, setSheetSyncing] = useState(false);
  const [sheetToast, setSheetToast] = useState(null); // { type: 'success'|'error', msg }
  const [showSheetsModal, setShowSheetsModal] = useState(false);
  const [customSheetInput, setCustomSheetInput] = useState('');
  const [savingCustomSheet, setSavingCustomSheet] = useState(false);

  async function handleSaveCustomSheet() {
    if (!customSheetInput.trim()) return;
    setSavingCustomSheet(true);
    try {
      const res = await fetch(`${API_URL}/sheets/set-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetId: customSheetInput.trim() })
      });
      const data = await res.json();
      if (data.ok) {
        setSheetUrl(data.url);
        setCustomSheetInput('');
        showSheetToast('success', 'Custom Google Sheet linked! ✓');
        setShowSheetsModal(false);
      } else {
        alert(data.error || 'Failed to link sheet');
      }
    } catch (err) {
      alert(`Error linking sheet: ${err.message}`);
    } finally {
      setSavingCustomSheet(false);
    }
  }
  
  const toastTimeoutRef  = useRef(null);
  const sheetToastRef    = useRef(null);

  // Check Google auth status on mount
  useEffect(() => {
    fetch(`${API_URL}/auth/google-status`)
      .then(r => r.json())
      .then(data => {
        setGoogleConnected(data.connected);
        if (data.user) setGoogleUser(data.user);
        if (data.connected) fetchSheetInfo();
      })
      .catch(() => {});
  }, []);

  // Listen for the OAuth popup telling us auth succeeded via postMessage
  useEffect(() => {
    function handleAuthMessage(event) {
      if (event.data === 'google-auth-success') {
        // Re-fetch live status from server so we get the user profile too
        fetch(`${API_URL}/auth/google-status`)
          .then(r => r.json())
          .then(data => {
            setGoogleConnected(data.connected);
            if (data.user) setGoogleUser(data.user);
            if (data.connected) fetchSheetInfo();
            showSheetToast('success', 'Google Sheets connected! ✓');
          })
          .catch(() => {});
      }
    }
    window.addEventListener('message', handleAuthMessage);
    return () => window.removeEventListener('message', handleAuthMessage);
  }, []);

  function fetchSheetInfo() {
    fetch(`${API_URL}/sheets/info`)
      .then(r => r.json())
      .then(data => setSheetUrl(data.url))
      .catch(() => {});
  }

  function showSheetToast(type, msg) {
    setSheetToast({ type, msg });
    if (sheetToastRef.current) clearTimeout(sheetToastRef.current);
    sheetToastRef.current = setTimeout(() => setSheetToast(null), 4000);
  }

  // ── Bluetooth Printer State (Mobile Direct Print) ───────────────────────────
  const [btPrinter, setBtPrinter] = useState(null);
  const [btConnecting, setBtConnecting] = useState(false);
  const [showBtHelpModal, setShowBtHelpModal] = useState(false);
  const btPrinterRef = useRef(null);

  useEffect(() => {
    btPrinterRef.current = btPrinter;
  }, [btPrinter]);

  async function handleConnectBluetooth() {
    setBtConnecting(true);
    try {
      const printer = await connectBluetoothPrinter(() => {
        setBtPrinter(null);
        btPrinterRef.current = null;
        showSheetToast('info', 'Bluetooth printer disconnected.');
      });
      setBtPrinter(printer);
      btPrinterRef.current = printer;
      showSheetToast('success', `Printer Connected: ${printer.name || 'NIIMBOT B1 Pro'} ✓`);
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        alert(`Bluetooth Error: ${err.message}`);
      }
    } finally {
      setBtConnecting(false);
    }
  }

  async function handleDisconnectBluetooth() {
    if (btPrinterRef.current) {
      await disconnectBluetoothPrinter(btPrinterRef.current);
      setBtPrinter(null);
      btPrinterRef.current = null;
      showSheetToast('info', 'Bluetooth printer disconnected.');
    }
  }

  async function handleTestPrintBluetooth() {
    if (!btPrinterRef.current) return;
    try {
      showSheetToast('info', 'Printing test label...');
      await printTest(btPrinterRef.current);
      showSheetToast('success', 'Test print sent successfully! ✓');
    } catch (err) {
      alert(`Test print error: ${err.message}`);
    }
  }

  // Connect Google account — opens OAuth popup
  async function connectGoogle() {
    try {
      const res  = await fetch(`${API_URL}/auth/google-url`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch {
        alert(`Backend error — make sure the server is running on port 3001.\n\nServer responded with HTML instead of JSON.`);
        return;
      }
      if (data.error) { alert(`Google Sheets: ${data.error}`); return; }
      window.open(data.url, '_blank', 'width=500,height=600');
    } catch (err) {
      alert(`Could not reach the backend server at ${API_URL}.\nMake sure "node server.js" is running.\n\nDetail: ${err.message}`);
    }
  }

  // Disconnect Google
  async function disconnectGoogle() {
    await fetch(`${API_URL}/auth/google-disconnect`, { method: 'POST' }).catch(() => {});
    setGoogleConnected(false);
    setGoogleUser(null);
    setSheetUrl(null);
  }

  // Auto-append a single order to Google Sheets (called after pin)
  async function appendOrderToSheet(order, dpAmount, allOrders, dpRecs) {
    if (!googleConnected) return;
    try {
      const res  = await fetch(`${API_URL}/sheets/append-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order,
          dpAmount: dpAmount || 0,
          orders: allOrders || [...orders, order],
          dpRecords: dpRecs || dpRecords
        })
      });
      const data = await res.json();
      if (data.ok) fetchSheetInfo();
    } catch (err) {
      console.warn('[Sheets] append error:', err.message);
    }
  }

  // Full sync — rewrite all rows with current DP values
  async function syncToSheet() {
    if (!googleConnected) return;
    setSheetSyncing(true);
    try {
      const res  = await fetch(`${API_URL}/sheets/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders, dpRecords })
      });
      const data = await res.json();
      if (data.ok) {
        fetchSheetInfo();
        showSheetToast('success', `Synced ${data.rowCount} rows to Google Sheets ✓`);
      } else {
        showSheetToast('error', data.error || 'Sync failed');
      }
    } catch (err) {
      showSheetToast('error', err.message);
    } finally {
      setSheetSyncing(false);
    }
  }

  useEffect(() => {
    const clockInterval = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(clockInterval);
  }, []);

  useEffect(() => {
    socket.on('connect_error', (err) => {
      setConnectionStatus('offline');
      setIsLive(false);
      console.warn('Socket connection error:', err?.message || err);
    });

    socket.on('tiktok-connected', (msg) => {
      setConnectionStatus('connected');
      setIsLive(true);
    });

    socket.on('tiktok-error', (msg) => {
      setConnectionStatus('offline');
      setIsLive(false);
      alert(msg);
    });

    socket.on('tiktok-disconnected', () => {
      setConnectionStatus('offline');
      setIsLive(false);
    });

    socket.on('tiktok-chat', (commentData) => {
      handleNewComment(commentData);
    });

    socket.on('tiktok-pinned-order', async (order) => {
      setOrders(prev => [...prev, order]);
      setLockedCodes(prev => [...prev, order.code]);
      setComments(prev =>
        prev.map(c =>
          c.username === order.username && c.text.includes(order.code)
            ? { ...c, status: 'success' }
            : c
        )
      );
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      setPrintToast({ ...order });
      toastTimeoutRef.current = setTimeout(() => setPrintToast(null), 3500);

      // Auto-print on phone if Bluetooth printer is connected!
      if (btPrinterRef.current) {
        try {
          await printInvoice(btPrinterRef.current, order);
          showSheetToast('success', `Sticker Printed: ${order.name} (${order.code}) ✓`);
        } catch (err) {
          console.warn('Bluetooth auto-print error:', err.message);
          showSheetToast('error', `BT Print: ${err.message}`);
        }
      }
    });

    // Google auth success from backend (popup callback)
    socket.on('google-auth-success', (payload) => {
      setGoogleConnected(true);
      if (payload?.user) setGoogleUser(payload.user);
      fetchSheetInfo();
      showSheetToast('success', 'Google Sheets connected! ✓');
    });

    return () => {
      socket.off('connect_error');
      socket.off('tiktok-connected');
      socket.off('tiktok-error');
      socket.off('tiktok-disconnected');
      socket.off('tiktok-chat');
      socket.off('tiktok-pinned-order');
      socket.off('google-auth-success');
    };
  }, []);

  const handleNewComment = (commentData) => {
    const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setComments(prev => {
      if (commentData.id && prev.some(c => c.id === commentData.id)) return prev;
      return [{ ...commentData, status: 'neutral', time: timeString }, ...prev].slice(0, 100);
    });
  };

  const pinComment = (comment) => {
    // Robust parsing supporting: "mine 23 150", "#23 150", "23 150", "DRESS1 599"
    const orderRegex = /(?:mine|grab|take|get|pouch)?\s*#?([a-zA-Z0-9_-]+)\s+[₱pP]?\s*(\d+)/i;
    const match = comment.text.match(orderRegex);

    if (!match) {
      alert(`No item code and price found in:\n"${comment.text}"\n\nExpected format: code price  (e.g. "23 129" or "mine 23 129")`);
      return;
    }

    const code  = match[1].toUpperCase();
    const price = parseInt(match[2], 10);
    const time  = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const newOrder = {
      id: Math.random().toString(36).substr(2, 9),
      name: comment.name,
      username: comment.username,
      code,
      amount: price,
      time
    };

    setOrders(prev => [...prev, newOrder]);
    setLockedCodes(prev => [...prev, code]);
    setComments(prev =>
      prev.map(c => c.id === comment.id ? { ...c, status: 'success' } : c)
    );

    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setPrintToast({ ...newOrder });
    toastTimeoutRef.current = setTimeout(() => setPrintToast(null), 3500);

    // 1. Direct Bluetooth auto-print on phone if connected!
    if (btPrinterRef.current) {
      printInvoice(btPrinterRef.current, newOrder).then(() => {
        showSheetToast('success', `Sticker Printed: ${newOrder.name} (${newOrder.code}) ✓`);
      }).catch(err => {
        console.warn('Bluetooth print error:', err.message);
        showSheetToast('error', `BT Print: ${err.message}`);
      });
    }

    // 2. Also notify desktop server
    socket.emit('print-invoice', newOrder);

    // 3. Auto-append to Google Sheets (appends raw item and refreshes buyer summary)
    appendOrderToSheet(newOrder, 0, [...orders, newOrder], dpRecords);
  };

  const startLive = () => {
    if (!targetUsername.trim()) { alert("Please enter a TikTok username"); return; }
    socket.connect();
    setConnectionStatus('connecting');
    socket.emit('connect-tiktok', targetUsername.trim());
  };

  const stopLive = () => {
    socket.emit('disconnect-tiktok');
    setConnectionStatus('offline');
    setIsLive(false);
  };

  const resetData = () => {
    setComments([]);
    setOrders([]);
    setLockedCodes([]);
    setDpRecords({});
    setSearchTerm('');
    setPrintToast(null);
  };

  const unlockCode = (codeToUnlock) => {
    setLockedCodes(prev => prev.filter(c => c !== codeToUnlock));
  };

  const cancelOrder = async (orderId, codeToUnlock) => {
    const updatedOrders = orders.filter(order => order.id !== orderId);
    setOrders(updatedOrders);
    unlockCode(codeToUnlock);

    // 1. Delete from SQLite DB
    try {
      fetch(`${API_URL}/api/pinned-orders/${orderId}`, { method: 'DELETE' }).catch(() => {});
    } catch (e) {}

    // 2. Auto-sync updated orders to Google Sheet so deleted item is removed
    if (googleConnected) {
      try {
        const res = await fetch(`${API_URL}/sheets/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders: updatedOrders, dpRecords })
        });
        const data = await res.json();
        if (data.ok) {
          showSheetToast('success', `Item deleted from Google Sheet ✓`);
        }
      } catch (err) {
        console.warn('Failed to sync deletion to Google Sheet:', err.message);
      }
    }
  };

  const handleDpChange = (username, value) => {
    const numValue = parseInt(value, 10);
    setDpRecords(prev => ({
      ...prev,
      [username]: isNaN(numValue) ? 0 : numValue
    }));
  };

  const groupedOrders = useMemo(() => {
    const groups = {};
    orders.forEach(order => {
      if (!groups[order.username]) {
        groups[order.username] = { name: order.name, username: order.username, items: [], total: 0 };
      }
      groups[order.username].items.push(order);
      groups[order.username].total += order.amount;
    });
    return Object.values(groups).sort((a, b) => b.total - a.total);
  }, [orders]);

  const filteredGroups = groupedOrders.filter(group =>
    group.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
    group.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalSales = orders.reduce((sum, order) => sum + order.amount, 0);

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans flex flex-col selection:bg-white/20">
      
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scroll::-webkit-scrollbar { width: 4px; }
        .custom-scroll::-webkit-scrollbar-track { background: transparent; }
        .custom-scroll::-webkit-scrollbar-thumb { background-color: #333; border-radius: 10px; }
        .custom-scroll::-webkit-scrollbar-thumb:hover { background-color: #555; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
        @keyframes spin-slow { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin-slow { animation: spin-slow 1.5s linear infinite; }
      `}} />

      {/* HEADER */}
      <header className="bg-black/60 backdrop-blur-xl border-b border-white/10 sticky top-0 z-30 px-3 sm:px-6 py-2.5 sm:py-4 shrink-0 shadow-2xl">
        <div className="flex flex-col lg:flex-row justify-between items-stretch lg:items-center gap-3">
          {/* Top row: Brand + Stats */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 sm:gap-4">
              <div className="bg-white/10 text-white p-2 rounded-xl border border-white/5 shadow-inner">
                <PackageSearch size={20} className="opacity-90" />
              </div>
              <div>
                <h1 className="text-base sm:text-xl font-bold text-white tracking-tight flex items-center gap-2">
                  Pawfit Desk
                  {connectionStatus === 'connected' && (
                    <span className="flex h-2 w-2 relative ml-1">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                    </span>
                  )}
                </h1>
                <div className="flex gap-3 sm:gap-5 text-[11px] sm:text-xs font-medium text-zinc-400">
                  <span className="flex items-center gap-1 text-emerald-400 font-semibold"><CheckCircle2 size={12}/> {orders.length} Sold</span>
                  <span className="flex items-center gap-1">₱ {totalSales.toLocaleString()}</span>
                  <span className="flex items-center gap-1">👥 {groupedOrders.length} Miners</span>
                </div>
              </div>
            </div>

            {/* Quick Sheets & Bluetooth buttons on mobile */}
            <div className="flex lg:hidden items-center gap-1.5">
              {/* Mobile Bluetooth Button */}
              <button
                onClick={btPrinter ? handleDisconnectBluetooth : handleConnectBluetooth}
                disabled={btConnecting}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                  btPrinter
                    ? 'bg-blue-500/20 text-blue-400 border-blue-500/40 shadow-[0_0_10px_rgba(59,130,246,0.15)]'
                    : 'bg-black/60 text-zinc-400 border-white/10 hover:text-white'
                }`}
                title={btPrinter ? `Connected to ${btPrinter.name}. Tap to disconnect.` : 'Connect NIIMBOT / Bluetooth Printer'}
              >
                <Bluetooth size={13} className={btPrinter ? 'text-blue-400 animate-pulse' : 'text-zinc-500'} />
                <span>{btPrinter ? `${(btPrinter.name || 'Niimbot').slice(0, 10)} ✓` : (btConnecting ? 'Pairing...' : 'Niimbot BT')}</span>
              </button>

              {btPrinter && (
                <button
                  onClick={handleTestPrintBluetooth}
                  className="bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 px-2 py-1 rounded-lg text-xs"
                  title="Test Print Label"
                >
                  <Printer size={12} />
                </button>
              )}

              <button
                onClick={() => setShowBtHelpModal(true)}
                className="bg-black/60 text-zinc-400 hover:text-blue-400 border border-white/10 p-1.5 rounded-lg text-xs transition-colors"
                title="Bluetooth & Niimbot Setup Guide"
              >
                <HelpCircle size={13} />
              </button>

              <button
                onClick={() => setShowSheetsModal(true)}
                className="flex items-center gap-1.5 bg-black/60 border border-white/10 rounded-lg px-2.5 py-1 text-xs hover:border-emerald-500/30 transition-colors"
                title="Google Sheets Settings"
              >
                <Sheet size={13} className={googleConnected ? 'text-emerald-400' : 'text-zinc-500'} />
                <span className={`text-[11px] font-semibold ${googleConnected ? 'text-emerald-400' : 'text-zinc-400'}`}>
                  {googleConnected ? 'Sheets' : 'Link'}
                </span>
              </button>
            </div>
          </div>
          
          {/* Controls: Input, Reset, Start Live */}
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap sm:flex-nowrap">
            {/* Desktop Bluetooth Widget */}
            <div className="hidden lg:flex items-center gap-2 bg-black/60 border border-white/10 rounded-xl px-3 py-2 h-9">
              <Bluetooth size={14} className={btPrinter ? 'text-blue-400 animate-pulse' : 'text-zinc-500'} />
              {btPrinter ? (
                <>
                  <span className="text-[11px] text-blue-400 font-semibold truncate max-w-[110px]">{btPrinter.name}</span>
                  <button
                    onClick={handleTestPrintBluetooth}
                    title="Send test print"
                    className="text-zinc-400 hover:text-white transition-colors"
                  >
                    <Printer size={12} />
                  </button>
                  <button
                    onClick={handleDisconnectBluetooth}
                    title="Disconnect Bluetooth Printer"
                    className="text-zinc-600 hover:text-rose-400 transition-colors"
                  >
                    <LogOut size={11} />
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectBluetooth}
                  disabled={btConnecting}
                  className="text-[11px] text-zinc-400 hover:text-white font-medium transition-colors"
                >
                  {btConnecting ? 'Pairing...' : 'Niimbot / BT'}
                </button>
              )}
              <button
                onClick={() => setShowBtHelpModal(true)}
                title="Niimbot Setup Guide"
                className="text-zinc-500 hover:text-blue-400 transition-colors ml-0.5"
              >
                <HelpCircle size={12} />
              </button>
            </div>

            {/* Desktop Google Sheets Widget */}
            <div className="hidden lg:flex items-center gap-2 bg-black/60 border border-white/10 rounded-xl px-3 py-2 h-9">
              <button
                onClick={() => setShowSheetsModal(true)}
                className="flex items-center gap-1.5 text-[11px] font-semibold hover:text-white transition-colors"
                title="Configure Google Sheet Link / Account"
              >
                <Sheet size={14} className={googleConnected ? 'text-emerald-400' : 'text-zinc-500'} />
                <span className={googleConnected ? 'text-emerald-400' : 'text-zinc-400'}>
                  {googleConnected ? 'Sheets' : 'Link Sheet'}
                </span>
              </button>
              {googleConnected && sheetUrl && (
                <a href={sheetUrl} target="_blank" rel="noreferrer" title="Open Google Sheet" className="text-zinc-500 hover:text-emerald-400 transition-colors">
                  <ExternalLink size={11} />
                </a>
              )}
              <button onClick={syncToSheet} disabled={sheetSyncing || orders.length === 0} title="Sync all orders & payments" className="text-zinc-400 hover:text-white disabled:opacity-30 transition-colors ml-1">
                <RefreshCcw size={12} className={sheetSyncing ? 'spin-slow' : ''} />
              </button>
            </div>

            {/* TikTok username input */}
            <div className="flex items-center bg-black border border-white/10 rounded-lg overflow-hidden h-9 flex-1 sm:w-52">
               <span className="pl-2.5 text-zinc-500 font-bold text-xs sm:text-sm">@</span>
               <input 
                 type="text"
                 placeholder="tiktok_username"
                 value={targetUsername}
                 onChange={(e) => setTargetUsername(e.target.value)}
                 disabled={isLive || connectionStatus === 'connecting'}
                 className="bg-transparent text-white px-2 py-2 w-full text-xs sm:text-sm outline-none placeholder:text-zinc-600 disabled:opacity-50"
               />
            </div>

            <button 
              onClick={resetData} 
              className="px-3 h-9 rounded-lg text-xs font-semibold bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/10 transition-colors flex items-center gap-1.5"
            >
              <RefreshCw size={13} /> <span className="hidden sm:inline">Reset</span>
            </button>
            
            <button 
              onClick={isLive ? stopLive : startLive}
              disabled={connectionStatus === 'connecting'}
              className={`px-4 sm:px-6 h-9 rounded-lg text-xs sm:text-sm font-bold transition-all flex items-center gap-1.5 shadow-lg border disabled:opacity-50 shrink-0 ${
                isLive 
                  ? 'bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 border-rose-500/20' 
                  : 'bg-white text-black hover:bg-zinc-200 border-white shadow-[0_0_20px_rgba(255,255,255,0.2)]'
              }`}
            >
              {connectionStatus === 'connecting' ? 'CONNECTING...' : (isLive ? <><Square size={13} className="fill-current"/> STOP</> : <><Play size={13} className="fill-current"/> START</>)}
            </button>
          </div>
        </div>
      </header>

      {/* MOBILE TAB BAR SWITCHER */}
      <div className="md:hidden flex border-b border-white/10 bg-[#0a0a0a] px-3 py-2 gap-2 shrink-0">
        <button
          onClick={() => setMobileTab('chat')}
          className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all ${
            mobileTab === 'chat'
              ? 'bg-white text-black shadow-md font-extrabold'
              : 'bg-white/5 text-zinc-400 hover:text-white'
          }`}
        >
          <MessageSquare size={15} /> Live Chat
          {comments.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${mobileTab === 'chat' ? 'bg-black text-white' : 'bg-white/10 text-zinc-300'}`}>
              {comments.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setMobileTab('pouches')}
          className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all ${
            mobileTab === 'pouches'
              ? 'bg-white text-black shadow-md font-extrabold'
              : 'bg-white/5 text-zinc-400 hover:text-white'
          }`}
        >
          <ShoppingBag size={15} /> Pouches
          {groupedOrders.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${mobileTab === 'pouches' ? 'bg-black text-white' : 'bg-emerald-500/20 text-emerald-400'}`}>
              {groupedOrders.length}
            </span>
          )}
        </button>
      </div>

      <div className="p-3 sm:p-6 grid grid-cols-1 md:grid-cols-12 gap-3 sm:gap-6 flex-1 min-h-0 overflow-hidden">
        
        {/* --- LEFT COLUMN: Locks & Chat --- */}
        <div className={`${mobileTab === 'chat' ? 'flex' : 'hidden'} md:flex col-span-1 md:col-span-4 flex-col gap-3 sm:gap-6 h-full min-h-0`}>
          
          {/* Locked Items */}
          <div className="bg-[#0f0f0f] border border-white/5 rounded-xl sm:rounded-2xl p-4 sm:p-5 shadow-2xl shrink-0 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-white/10 to-transparent"></div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2 uppercase tracking-widest">
                <Lock size={14} className="text-zinc-500" /> Vault
              </h2>
              {lockedCodes.length > 0 && (
                <button 
                  onClick={() => setLockedCodes([])} 
                  className="text-xs font-semibold text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>
            
            <div className="flex flex-wrap gap-2 max-h-[140px] overflow-y-auto custom-scroll">
              {lockedCodes.length === 0 ? (
                <span className="text-sm text-zinc-600 italic font-light">Awaiting orders...</span>
              ) : (
                lockedCodes.map(code => (
                  <button 
                    key={code} 
                    onClick={() => unlockCode(code)}
                    className="group flex items-center gap-1.5 bg-white/5 border border-white/10 text-zinc-300 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-rose-500/10 hover:text-rose-400 hover:border-rose-500/20 transition-all shadow-sm"
                    title={`Unlock ${code}`}
                  >
                    {code}
                    <Unlock size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Chat Stream */}
          <div className="bg-[#0f0f0f] border border-white/5 rounded-2xl flex-1 flex flex-col overflow-hidden shadow-2xl relative">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-white/10 to-transparent"></div>
            <div className="bg-black/20 border-b border-white/5 p-4 flex justify-between items-center shrink-0">
              <span className="font-semibold text-zinc-200 text-xs tracking-widest uppercase">Live Stream</span>
              <span className="text-zinc-400 font-mono text-[11px] flex items-center gap-1.5 bg-white/5 px-2.5 py-1 rounded-md border border-white/5 shadow-inner">
                <Clock size={12} className="text-zinc-400 animate-pulse" /> {currentTime}
              </span>
            </div>
            
            <div className="p-4 flex-1 overflow-y-auto flex flex-col gap-3 custom-scroll relative">
              {comments.length === 0 && (
                 <div className="m-auto text-zinc-600 text-sm italic font-light">
                   {isLive ? 'Waiting for comments...' : 'Enter a TikTok username and Start Live...'}
                 </div>
              )}
              {comments.map((comment, i) => (
                <div key={i} className={`group/comment p-3 rounded-xl border text-sm transition-all duration-300 animate-in fade-in slide-in-from-top-2 ${
                  comment.status === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.05)]' :
                  'bg-white/5 border-transparent hover:border-white/10'
                }`}>
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="font-semibold text-zinc-100 flex items-center gap-2">
                      {comment.name} 
                      <span className="text-zinc-500 font-light text-xs">{comment.username}</span>
                      {comment.time && <span className="text-zinc-600 font-mono text-[10px]">{comment.time}</span>}
                    </span>
                    {comment.status === 'success'
                      ? <span className="text-[10px] sm:text-[9px] tracking-wider bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 px-2.5 py-1 rounded-md font-bold flex items-center gap-1"><Pin size={10}/>WINNER</span>
                      : (
                        <button
                          onClick={() => pinComment(comment)}
                          title="Pin as winner & print invoice"
                          className="opacity-100 md:opacity-0 md:group-hover/comment:opacity-100 transition-opacity flex items-center gap-1 text-[11px] sm:text-[9px] tracking-wider bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 px-3 py-1.5 sm:px-2 sm:py-0.5 rounded-lg font-bold shadow-sm active:scale-95"
                        >
                          <Pin size={11} className="fill-amber-300"/> PIN
                        </button>
                      )
                    }
                  </div>
                  <p className={comment.status === 'success' ? 'text-emerald-300 font-medium' : 'text-zinc-300 font-light'}>
                    {comment.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* --- RIGHT COLUMN: Miner's Pouches --- */}
        <div className={`${mobileTab === 'pouches' ? 'flex' : 'hidden'} md:flex col-span-1 md:col-span-8 flex-col h-full bg-[#0a0a0a] rounded-xl sm:rounded-2xl overflow-hidden border border-white/5 shadow-2xl relative min-h-0`}>
          
          <div className="bg-[#0f0f0f] border-b border-white/5 p-3 sm:p-4 flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2 sm:gap-3 sticky top-0 z-10 shrink-0">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-zinc-200 tracking-widest uppercase text-xs sm:text-sm">Pouches</h2>
              {googleConnected && orders.length > 0 && (
                <button
                  onClick={syncToSheet}
                  disabled={sheetSyncing}
                  className="sm:hidden flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-lg"
                >
                  <RefreshCcw size={11} className={sheetSyncing ? 'spin-slow' : ''} />
                  {sheetSyncing ? 'Syncing...' : 'Sync Sheet'}
                </button>
              )}
            </div>
            
            <div className="flex items-center gap-3">
              {googleConnected && orders.length > 0 && (
                <button
                  onClick={syncToSheet}
                  disabled={sheetSyncing}
                  className="hidden sm:flex items-center gap-1.5 text-[11px] font-semibold text-emerald-500 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/20 px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
                  title="Sync all orders + DP payments to Google Sheets"
                >
                  <RefreshCcw size={11} className={sheetSyncing ? 'spin-slow' : ''} />
                  {sheetSyncing ? 'Syncing...' : 'Sync to Sheet'}
                </button>
              )}
              <div className="relative flex-1 sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
                <input 
                  type="text" 
                  placeholder="Search miner..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-black border border-white/10 text-zinc-100 pl-9 pr-4 py-2 rounded-lg text-xs sm:text-sm focus:outline-none focus:ring-1 focus:ring-white/20 focus:border-white/30 transition-all placeholder:text-zinc-600 font-light"
                />
              </div>
            </div>
          </div>

          <div className="p-3 sm:p-5 overflow-y-auto flex-1 custom-scroll bg-black/20 min-h-0">
            {filteredGroups.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-zinc-600 gap-4 py-12">
                <Printer size={48} className="opacity-20" />
                <p className="text-sm font-light">No active pouches.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4 auto-rows-max">
                {filteredGroups.map(group => {
                  
                  const dpAmount = dpRecords[group.username] || 0;
                  const balance  = group.total - dpAmount;
                  
                  let borderColor = "border-white/10"; 
                  let badgeText   = "UNPAID";
                  let badgeClass  = "bg-white/5 text-zinc-400 border-white/10";
                  let cardGlow    = "";

                  if (group.total > 0) {
                    if (balance <= 0) {
                      borderColor = "border-emerald-500/40";
                      cardGlow    = "shadow-[0_0_15px_rgba(16,185,129,0.1)]";
                      badgeText   = "PAID";
                      badgeClass  = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
                    } else if (dpAmount > 0) {
                      borderColor = "border-amber-500/40";
                      badgeText   = "PARTIAL";
                      badgeClass  = "bg-amber-500/10 text-amber-400 border-amber-500/20";
                    } else {
                      borderColor = "border-white/10 hover:border-white/20";
                      badgeText   = "UNPAID";
                      badgeClass  = "bg-rose-500/10 text-rose-400 border-rose-500/20";
                    }
                  }

                  return (
                    <div key={group.username} className={`bg-[#0f0f0f] rounded-xl border ${borderColor} ${cardGlow} flex flex-col overflow-hidden transition-all duration-300 animate-in zoom-in-95 group`}>
                      
                      {/* Pouch Header */}
                      <div className="p-3 bg-black/40 border-b border-white/5 flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-zinc-200 font-bold text-sm shrink-0">
                          {group.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 overflow-hidden">
                          <h3 className="font-semibold text-zinc-100 truncate text-xs">{group.name}</h3>
                          <p className="text-[10px] text-zinc-500 font-light truncate">{group.username}</p>
                        </div>
                        <div className={`text-[9px] font-bold px-1.5 py-0.5 rounded border tracking-wider shrink-0 ${badgeClass}`}>
                          {badgeText}
                        </div>
                      </div>

                      {/* Pouch Items */}
                      <div className="p-1.5 flex-1 flex flex-col gap-1 min-h-[80px] bg-black/10">
                        {group.items.map((item) => (
                          <div key={item.id} className="group/item flex justify-between items-center text-xs p-1.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/5 transition-all">
                            <div className="flex items-center gap-2">
                              <span className="bg-white/10 text-zinc-200 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider">{item.code}</span>
                              <span className="text-zinc-600 text-[9px] flex items-center gap-1 font-light"><Clock size={9}/>{item.time}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-zinc-300 text-xs">₱{item.amount}</span>
                              <button 
                                onClick={() => cancelOrder(item.id, item.code)}
                                className="text-zinc-400 hover:text-rose-400 bg-transparent hover:bg-rose-500/10 p-1.5 rounded opacity-100 md:opacity-0 md:group-hover/item:opacity-100 transition-all active:scale-90"
                                title="Cancel Item & Unlock Code"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Footer */}
                      <div className="bg-black/40 p-3 border-t border-white/5">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Subtotal ({group.items.length})</span>
                          <span className="font-medium text-zinc-200 text-xs">₱{group.total.toLocaleString()}</span>
                        </div>
                        
                        <div className="flex items-center justify-between gap-2 bg-black p-1.5 rounded-lg border border-white/5 focus-within:border-white/20 transition-colors">
                          <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest pl-1">DP/Paid</span>
                          <div className="flex items-center">
                            <span className="text-zinc-600 text-xs mr-1 font-medium">₱</span>
                            <input 
                              type="number" 
                              placeholder="0"
                              min="0"
                              value={dpRecords[group.username] || ''}
                              onChange={(e) => handleDpChange(group.username, e.target.value)}
                              className="w-16 text-right bg-transparent border-b border-white/10 focus:border-white/40 focus:outline-none text-xs font-medium text-zinc-200 py-0.5"
                            />
                          </div>
                        </div>

                        <div className="flex justify-between items-center mt-3 pt-3 border-t border-white/5">
                          <span className="text-xs font-semibold text-zinc-400">Balance</span>
                          <span className={`text-sm font-bold ${balance <= 0 ? 'text-emerald-400' : 'text-zinc-100'}`}>
                            ₱{Math.max(0, balance).toLocaleString()}
                          </span>
                        </div>
                      </div>

                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Print Toast */}
      {printToast && (
        <div className="fixed bottom-8 right-8 bg-black/90 backdrop-blur-md text-white p-4 rounded-xl shadow-[0_0_30px_rgba(0,0,0,0.5)] border border-white/10 flex items-center gap-4 animate-in slide-in-from-right-8 fade-in z-50">
          <div className="bg-white/10 text-zinc-100 p-2.5 rounded-lg border border-white/10">
            <Printer size={18} className="animate-pulse" />
          </div>
          <div>
            <p className="font-semibold text-xs tracking-wide">Printing Invoice...</p>
            <p className="text-[10px] text-zinc-400 mt-1 font-light">{printToast.name} • Code: <span className="font-medium text-emerald-400">{printToast.code}</span></p>
          </div>
        </div>
      )}

      {/* Google Sheets Toast */}
      {sheetToast && (
        <div className={`fixed bottom-8 left-8 backdrop-blur-md text-white p-4 rounded-xl shadow-[0_0_30px_rgba(0,0,0,0.5)] border flex items-center gap-3 animate-in slide-in-from-left-8 fade-in z-50 ${
          sheetToast.type === 'success'
            ? 'bg-emerald-900/80 border-emerald-500/30'
            : 'bg-rose-900/80 border-rose-500/30'
        }`}>
          <Sheet size={16} className={sheetToast.type === 'success' ? 'text-emerald-400' : 'text-rose-400'} />
          <p className="text-xs font-semibold">{sheetToast.msg}</p>
        </div>
      )}

      {/* Google Sheets Modal */}
      {showSheetsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#121214] border border-white/10 rounded-2xl w-full max-w-lg shadow-[0_10px_40px_rgba(0,0,0,0.8)] overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 sm:p-5 border-b border-white/10 bg-white/[0.02]">
              <div className="flex items-center gap-2.5">
                <div className="bg-emerald-500/20 text-emerald-400 p-2 rounded-xl border border-emerald-500/20">
                  <Sheet size={18} />
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-white">Google Sheets Settings</h3>
                  <p className="text-[11px] text-zinc-400">Sync live pins & payments automatically</p>
                </div>
              </div>
              <button 
                onClick={() => setShowSheetsModal(false)}
                className="text-zinc-500 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-4 sm:p-5 space-y-5">

              {/* ── Google Account Card ─────────────────────────── */}
              <div className="bg-black/50 border border-white/5 rounded-xl p-3.5">
                {googleConnected && googleUser ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {googleUser.picture ? (
                        <img
                          src={googleUser.picture}
                          alt={googleUser.name}
                          className="w-10 h-10 rounded-full border-2 border-emerald-500/40 shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
                          <span className="text-emerald-400 font-bold text-sm">
                            {googleUser.name?.[0]?.toUpperCase() || 'G'}
                          </span>
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{googleUser.name}</p>
                        <p className="text-[11px] text-zinc-400 truncate">{googleUser.email}</p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          <span className="text-[10px] text-emerald-400 font-medium">Connected to Sheets</span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={disconnectGoogle}
                      className="flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300 border border-rose-500/20 hover:border-rose-500/40 bg-rose-500/10 px-3 py-1.5 rounded-lg transition-colors font-medium shrink-0"
                    >
                      <LogOut size={12} /> Sign Out
                    </button>
                  </div>
                ) : googleConnected ? (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="text-xs font-semibold text-white">Google Account Connected</span>
                    </div>
                    <button
                      onClick={disconnectGoogle}
                      className="flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300 border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 rounded-lg transition-colors font-medium"
                    >
                      <LogOut size={12} /> Sign Out
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-zinc-600" />
                      <span className="text-xs font-semibold text-zinc-400">No Account Connected</span>
                    </div>
                    <button
                      onClick={connectGoogle}
                      className="flex items-center gap-1.5 text-xs bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 px-3.5 py-1.5 rounded-lg font-semibold transition-all shadow-[0_0_15px_rgba(16,185,129,0.15)]"
                    >
                      Sign in with Google
                    </button>
                  </div>
                )}
              </div>

              {/* ── Daily Sheet Info ───────────────────────────────── */}
              {googleConnected && (
                <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-3.5 space-y-1.5">
                  <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                    <Sheet size={13} /> Auto Daily Worksheet
                  </p>
                  <p className="text-[11px] text-zinc-300 leading-relaxed">
                    Every pin automatically creates a new worksheet for today:<br />
                    <span className="font-mono text-emerald-300 text-[11px] bg-black/40 px-2 py-0.5 rounded mt-1 inline-block">
                      tiktok sales-{(() => { const n=new Date(); return `${String(n.getMonth()+1).padStart(2,'0')}.${String(n.getDate()).padStart(2,'0')}.${String(n.getFullYear()).slice(-2)}`; })()}
                    </span>
                  </p>
                  {sheetUrl && (
                    <a href={sheetUrl} target="_blank" rel="noreferrer"
                      className="text-[11px] text-emerald-400 hover:underline flex items-center gap-1 font-medium mt-1">
                      Open Spreadsheet <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              )}

              {/* ── Custom Spreadsheet Link / ID ────────────────────── */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <Link2 size={13} className="text-emerald-400" />
                  Link a Google Sheet (paste URL or ID):
                </label>
                <p className="text-[11px] text-zinc-400">
                  Paste any existing Sheet URL. New pins will be added to today's dated worksheet inside it.
                </p>
                <div className="flex gap-2 pt-1">
                  <input
                    type="text"
                    placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                    value={customSheetInput}
                    onChange={(e) => setCustomSheetInput(e.target.value)}
                    className="flex-1 bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder:text-zinc-600 outline-none focus:border-emerald-500/50 transition-colors"
                  />
                  <button
                    onClick={handleSaveCustomSheet}
                    disabled={savingCustomSheet || !customSheetInput.trim()}
                    className="bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-40 text-emerald-400 border border-emerald-500/30 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors"
                  >
                    {savingCustomSheet ? 'Linking...' : 'Link Sheet'}
                  </button>
                </div>
              </div>

              {/* ── Sync Controls ─────────────────────────────────── */}
              {googleConnected && (
                <div className="pt-2 border-t border-white/5 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-zinc-300">Sync Existing Orders</p>
                    <p className="text-[11px] text-zinc-500">Push all current miners & items to the sheet</p>
                  </div>
                  <button
                    onClick={() => { syncToSheet(); setShowSheetsModal(false); }}
                    disabled={sheetSyncing || orders.length === 0}
                    className="flex items-center gap-1.5 bg-white/10 hover:bg-white/15 disabled:opacity-40 text-white text-xs font-medium px-3.5 py-1.5 rounded-lg border border-white/10 transition-colors"
                  >
                    <RefreshCcw size={12} className={sheetSyncing ? 'spin-slow' : ''} />
                    {sheetSyncing ? 'Syncing...' : 'Sync Now'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* NIIMBOT / Bluetooth Quick Guide Modal */}
      {showBtHelpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#18181b] border border-white/10 rounded-2xl p-6 max-w-md w-full shadow-2xl relative text-left">
            <button
              onClick={() => setShowBtHelpModal(false)}
              className="absolute top-4 right-4 text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-white/5"
            >
              <X size={18} />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 rounded-xl bg-blue-500/20 text-blue-400 border border-blue-500/30">
                <Bluetooth size={22} />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">NIIMBOT B1 Pro Setup</h3>
                <p className="text-xs text-zinc-400">Bluetooth connection guide for Android & iPhone</p>
              </div>
            </div>

            <div className="space-y-3 text-xs text-zinc-300">
              <div className="flex gap-2.5 items-start p-2.5 rounded-xl bg-white/5 border border-white/5">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500/20 text-blue-400 font-bold flex items-center justify-center text-[10px]">1</span>
                <div>
                  <strong className="text-white block mb-0.5">Turn On Niimbot Printer</strong>
                  Hold the power button on your <strong>NIIMBOT B1 Pro</strong> until the green light stays on. Make sure label roll is loaded.
                </div>
              </div>

              <div className="flex gap-2.5 items-start p-2.5 rounded-xl bg-white/5 border border-white/5">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500/20 text-blue-400 font-bold flex items-center justify-center text-[10px]">2</span>
                <div>
                  <strong className="text-white block mb-0.5">Use Chrome via HTTPS</strong>
                  Make sure you open Pawfit Desk in <strong>Google Chrome</strong> on Android using <strong>https://</strong> (Web Bluetooth requires HTTPS).
                </div>
              </div>

              <div className="flex gap-2.5 items-start p-2.5 rounded-xl bg-white/5 border border-white/5">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500/20 text-blue-400 font-bold flex items-center justify-center text-[10px]">3</span>
                <div>
                  <strong className="text-white block mb-0.5">Tap "Niimbot / BT" to Connect</strong>
                  Even if paired in Android Settings, tap the blue <strong>Niimbot BT</strong> button in this dashboard, select <strong>NIIMBOT B1 Pro</strong> from Chrome's device list, and tap <strong>Pair</strong>.
                </div>
              </div>

              <div className="flex gap-2.5 items-start p-2.5 rounded-xl bg-white/5 border border-white/5">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500/20 text-blue-400 font-bold flex items-center justify-center text-[10px]">4</span>
                <div>
                  <strong className="text-white block mb-0.5">Auto-Print on Pinned Comments</strong>
                  Once connected, test print using the printer icon. When you pin any comment during TikTok Live (e.g. <em>"23 129"</em> or <em>"mine 23 129"</em>), the invoice sticker will print automatically!
                </div>
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => {
                  setShowBtHelpModal(false);
                  handleConnectBluetooth();
                }}
                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2.5 rounded-xl text-xs transition-colors flex items-center justify-center gap-1.5 shadow-lg shadow-blue-600/30"
              >
                <Bluetooth size={14} />
                Connect NIIMBOT Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}