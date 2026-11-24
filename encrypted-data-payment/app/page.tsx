'use client';

import { channelFundingGuidance } from '../lib/channel-funding';
import { useEffect, useRef, useState } from 'react';
import { scriptToAddress, type Channel, type FiberBrowserNode, type GetPaymentResult } from '@fiber-pay/sdk/browser';
import { decryptResult, toHex } from '../lib/crypto';
import { buildDeliverable, formatBytes, openDeliverable, type OpenedDeliverable, type OpenedFile } from '../lib/deliverable';
import { demoDeliverable } from '../lib/demo-deliverable';
import { bottle, channelFundingCkb, connectAndOpenChannel, readChannel, ready, startRole } from '../lib/fiber';
import { createOffer, parseOffer, type EncryptedOffer } from '../lib/offer';
import { payForOffer, validateOffer } from '../lib/payment';
import { createBrowserNodeSession } from '../lib/node-session';
import { encryptedSessionKey, encryptedBuyerProfile, encryptedSellerProfile, savedNodeIdentifier, readEncryptedProgress, type EncryptedLessonProgress } from '../lib/progress';

type Role = 'buyer' | 'seller';
const ckb = (value: string) => `${Number(BigInt(value)) / 100_000_000}`;
type Form = { title: string; seller: string; description: string; sample: string; note: string };
type Picked = { name: string; type: string; bytes: Uint8Array };
const emptyForm: Form = { title: '', seller: '', description: '', sample: '', note: '' };

export default function Page() {
  const nodes = useRef<Partial<Record<Role, FiberBrowserNode>>>({});
  const sessions = useRef<Partial<Record<Role, ReturnType<typeof createBrowserNodeSession>>>>({});
  const progress = useRef<EncryptedLessonProgress | null>(null);
  const locked = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addresses, setAddresses] = useState<Partial<Record<Role, string>>>({});
  const [connected, setConnected] = useState<Partial<Record<Role, boolean>>>({});
  const [channels, setChannels] = useState<Partial<Record<Role, Channel>>>({});
  const [form, setForm] = useState<Form>(emptyForm);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [generated, setGenerated] = useState('');
  const [received, setReceived] = useState('');
  const [offer, setOffer] = useState<EncryptedOffer | null>(null);
  const [attempt, setAttempt] = useState('');
  const [tested, setTested] = useState(false);
  const [payment, setPayment] = useState<GetPaymentResult | null>(null);
  const [key, setKey] = useState('');
  const [delivered, setDelivered] = useState<OpenedDeliverable | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = readEncryptedProgress(sessionStorage, localStorage);
    progress.current = saved;
    if (saved) { setGenerated(saved.generatedOffer); setReceived(saved.buyerOfferText); setAttempt(saved.attemptedPaymentHash); setTested(saved.triedWithoutKey); }
    setLoaded(true);
    const owned = sessions.current;
    const stop = () => { for (const session of Object.values(owned)) void session.stop().catch(() => {}); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); nodes.current = {}; sessions.current = {}; };
  }, []);

  function save(update: Partial<EncryptedLessonProgress>) {
    const buyerId = savedNodeIdentifier(localStorage, encryptedBuyerProfile);
    const sellerId = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    if (!buyerId || !sellerId) throw new Error('Start both saved nodes before continuing.');
    const next = { version: 1 as const, buyerId, sellerId, generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, ...progress.current, ...update };
    sessionStorage.setItem(encryptedSessionKey, JSON.stringify(next));
    progress.current = next;
  }

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed. Check status before retrying a transfer.'); }
    finally { locked.current = false; setBusy(false); }
  }

  async function refresh(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await readChannel(node);
    const { peers } = await node.listPeers();
    setConnected((previous) => ({ ...previous, [role]: peers.some(peer => peer.pubkey.replace(/^0x/i, '').toLowerCase() === bottle.pubkey.slice(2)) }));
    setChannels((previous) => ({ ...previous, [role]: channel }));
  }

  async function start(role: Role) {
    if (nodes.current[role]) return;
    const session = sessions.current[role] ??= createBrowserNodeSession();
    let started: FiberBrowserNode | undefined;
    await session.start(role === 'buyer' ? encryptedBuyerProfile : encryptedSellerProfile, async (track) => {
      started = await startRole(role, track);
    });
    if (!started) return;
    nodes.current[role] = started;
    const info = await started.nodeInfo();
    setAddresses((previous) => ({ ...previous, [role]: scriptToAddress(info.default_funding_lock_script, 'testnet') }));
    if (await readChannel(started)) await started.connectPeer(bottle);
    await refresh(role);
  }

  async function open(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await connectAndOpenChannel(node);
    setChannels((previous) => ({ ...previous, [role]: channel }));
    await refresh(role);
    setStatus(channel && ready(channel) ? 'Channel ready.' : 'Opening submitted. Check channel status after confirmation.');
  }

  async function moveLiquidity() {
    const node = nodes.current.seller;
    if (!node) return;
    const id = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    const storageKey = `fiber-docs:encrypted-inbound:${id}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing === 'submitting') throw new Error('Transfer outcome unknown. Review payment history before sending again.');
    let result: GetPaymentResult;
    if (existing) result = await node.getPayment({ payment_hash: existing as `0x${string}` });
    else {
      sessionStorage.setItem(storageKey, 'submitting');
      result = await node.sendPayment({ target_pubkey: bottle.pubkey, amount: '0x1dcd65000', keysend: true });
      sessionStorage.setItem(storageKey, result.payment_hash);
    }
    if (!['Success', 'Failed'].includes(result.status)) result = await node.waitForPayment(result.payment_hash, { timeout: 60_000, interval: 1_000 });
    if (result.status === 'Failed') sessionStorage.removeItem(storageKey);
    setStatus(`Liquidity transfer: ${result.status}`);
    await refresh('seller');
  }

  async function makeOffer() {
    if (!nodes.current.seller || !channels.seller || !routeReady || generated || attempt) return;
    const deliverable = await buildDeliverable({ ...form, files: picked });
    const value = await createOffer(nodes.current.seller, channels.seller, deliverable);
    save({ generatedOffer: value }); setGenerated(value); setStatus('Deliverable encrypted. Invoice created.');
  }

  async function pickFiles(list: FileList | null) {
    if (!list) return;
    setPicked(await Promise.all(Array.from(list).map(async (file) =>
      ({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }))));
  }

  function loadDemo() {
    const { files, ...fields } = demoDeliverable();
    setForm((previous) => ({ ...fields, seller: previous.seller })); setPicked(files);
  }

  async function unlock() {
    if (!offer || !key) return;
    const plaintext = await decryptResult(offer, key);
    const opened = await openDeliverable(plaintext, offer.preview);
    setDelivered(opened);
    setStatus(opened.allMatch ? 'Unlocked. Every file matches the preview.' : 'Unlocked, but some files do not match the preview.');
  }

  function download(file: OpenedFile) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.type }));
    const link = document.createElement('a');
    link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async function validate() {
    if (!nodes.current.buyer) return;
    const parsed = parseOffer(received);
    await validateOffer(nodes.current.buyer, parsed);
    if (attempt && parsed.paymentHash.toLowerCase() !== attempt.toLowerCase()) throw new Error('Restore the offer for the previous payment.');
    save({ buyerOfferText: received }); setOffer(parsed); setStatus('Offer validated.');
  }

  async function testLock() {
    if (!offer) return;
    try { await decryptResult(offer, toHex(crypto.getRandomValues(new Uint8Array(32)))); }
    catch { save({ triedWithoutKey: true }); setTested(true); setStatus('Decryption rejected: key unavailable.'); }
  }

  async function pay() {
    if (!nodes.current.buyer || !offer || !tested || !routeReady) return;
    const result = await payForOffer(nodes.current.buyer, offer, attempt, (hash) => {
      save({ attemptedPaymentHash: hash }); setAttempt(hash);
    }, payment?.status === 'Failed');
    acceptPayment(result);
    await Promise.all([refresh('buyer'), refresh('seller')]);
  }

  function acceptPayment(result: GetPaymentResult) {
    setPayment(result); setStatus(`Payment: ${result.status}`);
    if (result.status === 'Failed') setError(result.failed_error ?? 'Payment failed. Check channel liquidity before retrying.');
    if (result.status === 'Success' && result.payment_preimage) setKey(result.payment_preimage);
  }

  async function checkPayment() {
    if (!nodes.current.buyer || !offer || !attempt) return;
    await validateOffer(nodes.current.buyer, offer);
    acceptPayment(await nodes.current.buyer.getPayment({ payment_hash: attempt as `0x${string}` }));
  }

  function startAnotherOffer() {
    if (busy || (attempt && payment?.status !== 'Failed')) return;
    save({ generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, completedSteps: [] });
    setGenerated(''); setReceived(''); setOffer(null); setAttempt(''); setTested(false);
    setPayment(null); setKey(''); setDelivered(null); setError('');
    setStatus('Create a fresh handover offer.');
  }

  const routeReady = Boolean(connected.buyer && connected.seller && channels.buyer && ready(channels.buyer) && BigInt(channels.buyer.local_balance) >= 100_000_000n && channels.seller && ready(channels.seller) && BigInt(channels.seller.remote_balance) >= 100_000_000n);
  const canSubmit = Boolean(offer && tested && routeReady && !key && (!attempt || payment?.status === 'Failed'));

  return <main>
    <p className="eyebrow">Fiber Testnet · Pay to unlock</p><h1>Handover</h1>
    <p className="lede">A freelancer encrypts the finished work. The client sees a free preview and file hashes, pays a Fiber invoice, and the payment itself reveals the key.</p>
    {status && <p className="status" role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    <div className="grid">{(['buyer', 'seller'] as const).map((role) => <section className="card" key={role}>
      <h2>{role === 'buyer' ? 'Client · Buyer A' : 'Freelancer · Seller C'}</h2>
      {!addresses[role] && <button disabled={!loaded || busy} onClick={() => void run(() => start(role))}>Start node</button>}
      {addresses[role] && <><code>{addresses[role]}</code><a href="https://faucet.nervos.org" target="_blank" rel="noreferrer">Get Testnet CKB ↗</a>
        {!channels[role] && <p>{channelFundingGuidance}</p>}
        <button disabled={busy} onClick={() => void run(() => open(role))}>{channels[role] ? 'Reconnect / check channel' : `Open ${channelFundingCkb} CKB channel`}</button>
        <button disabled={busy} onClick={() => void run(() => refresh(role))}>Refresh channel status</button>
      </>}
      {channels[role] && <><code>{channels[role].state.state_name}</code><p>{role}: {ckb(channels[role].local_balance)} CKB · Bottle: {ckb(channels[role].remote_balance)} CKB</p></>}
    </section>)}</div>
    <section className="card"><h2>Liquidity</h2><button disabled={busy || !channels.seller || !ready(channels.seller) || BigInt(channels.seller.local_balance) < 500_000_000n} onClick={() => void run(moveLiquidity)}>Send / check 5 CKB transfer</button></section>
    <div className="grid exchange"><section className="card"><h2>Freelancer: package the work</h2>
      <label className="field">Title<input aria-label="Deliverable title" disabled={busy || Boolean(generated)} value={form.title} maxLength={120} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
      <label className="field">Your name or studio (shown to the client)<input aria-label="Seller name" disabled={busy || Boolean(generated)} value={form.seller} maxLength={80} onChange={e => setForm({ ...form, seller: e.target.value })} /></label>
      <label className="field">What the client is buying (public)<textarea aria-label="Description" disabled={busy || Boolean(generated)} value={form.description} maxLength={600} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
      <label className="field">Free sample (public)<textarea aria-label="Free sample" disabled={busy || Boolean(generated)} value={form.sample} maxLength={2000} onChange={e => setForm({ ...form, sample: e.target.value })} /></label>
      <label className="field">Private note (encrypted with the files)<textarea aria-label="Private note" disabled={busy || Boolean(generated)} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></label>
      <label className="field">Files to deliver (up to {formatBytes(100 * 1024)} total)<input aria-label="Files" type="file" multiple disabled={busy || Boolean(generated)} onChange={e => void run(() => pickFiles(e.target.files))} /></label>
      {picked.length > 0 && <p className="muted">{picked.map(file => `${file.name} (${formatBytes(file.bytes.length)})`).join(' · ')}</p>}
      <button disabled={busy || Boolean(generated)} onClick={loadDemo}>Use sample deliverable</button>
      <button disabled={busy || !routeReady || !form.title.trim() || picked.length === 0 || Boolean(generated || attempt)} onClick={() => void run(makeOffer)}>Encrypt & create 1 CKB invoice</button>
      <textarea aria-label="Generated offer" readOnly value={generated} />
      <button disabled={!generated || busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(generated); setStatus('Offer copied.'); })}>Copy offer</button>
    </section><section className="card"><h2>Client: pay and unlock</h2>
      <textarea aria-label="Received offer" disabled={busy || Boolean(offer || attempt)} value={received} onChange={e => { setReceived(e.target.value); setTested(false); }} />
      <button disabled={busy || !received || !addresses.buyer || Boolean(offer)} onClick={() => void run(validate)}>Validate offer</button>
      {!tested && <button disabled={busy || !offer} onClick={() => void run(testLock)}>Try to open without paying</button>}
      {canSubmit && <button disabled={busy} onClick={() => void run(pay)}>{attempt ? 'Retry failed payment' : 'Pay 1 CKB'}</button>}
      {attempt && !key && <button disabled={busy || !offer || !addresses.buyer} onClick={() => void run(checkPayment)}>Check payment status</button>}
      <button disabled={busy || !offer || !key || Boolean(delivered)} onClick={() => void run(unlock)}>Unlock with revealed key</button>
    </section></div>
    {offer && <section className="card"><h2>{offer.preview.title}</h2>
      {offer.preview.seller && <p className="muted">From {offer.preview.seller} · price 1 CKB</p>}
      {offer.preview.description && <p>{offer.preview.description}</p>}
      {offer.preview.sample && <><h3>Free sample</h3><pre className="sample">{offer.preview.sample}</pre></>}
      <h3>Locked files</h3>
      <ul className="files">{offer.preview.files.map(file => <li key={file.name}><strong>{file.name}</strong> <span>{formatBytes(file.size)}</span><code>sha256 {file.sha256}</code></li>)}</ul>
    </section>}
    {payment?.status === 'Success' && <section className="card"><h2>Receipt</h2><p>Amount: 1 CKB · Fee: {ckb(payment.fee)} CKB · Total: {ckb(`0x${(100_000_000n + BigInt(payment.fee)).toString(16)}`)} CKB</p><code>{payment.payment_hash}</code></section>}
    {delivered && <section className="result"><h2>Delivered files</h2>
      <p className={delivered.allMatch ? 'ok' : 'warn'} role="status">{delivered.allMatch
        ? `All ${delivered.files.length} files match the hashes shown before payment.`
        : `Warning: ${delivered.files.filter(file => !file.matchesPreview).length} file(s) differ from the preview${delivered.missing.length ? `, and ${delivered.missing.length} promised file(s) are missing` : ''}.`}</p>
      {delivered.note && <><h3>Note from the freelancer</h3><pre>{delivered.note}</pre></>}
      <ul className="files">{delivered.files.map(file => <li key={file.name}>
        <strong>{file.name}</strong> <span>{formatBytes(file.size)} · {file.matchesPreview ? 'hash matches' : 'HASH MISMATCH'}</span>
        <button onClick={() => download(file)}>Download</button>
        {file.text !== undefined && <details open><summary>Preview</summary><pre>{file.text}</pre></details>}
      </li>)}</ul>
    </section>}
    {(generated || received) && (!attempt || payment?.status === 'Failed') && <button disabled={busy} onClick={() => void run(async () => startAnotherOffer())}>Start another offer</button>}
  </main>;
}
