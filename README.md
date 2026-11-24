# Handover: pay to unlock a freelancer's finished work

Built on the Fiber encrypted-data-payment starter ([walkthrough](https://www.fiber.world/docs/build/encrypted-data-payment)) for Quest 2 (Advanced).

**The problem.** A freelancer and a client each want the other to move first. The freelancer won't send the finished files before being paid, and the client won't pay for files they haven't seen.

**What this does.** The freelancer encrypts the deliverable and publishes an offer containing a free preview and a SHA-256 hash of every file. The client pays a 1 CKB Fiber Testnet invoice. The invoice's payment preimage *is* the AES key, so completing the payment is what reveals the key. The app then decrypts the files in the browser and checks each one against the hashes the client saw before paying.

## The flow

1. **Freelancer** starts a node, opens a channel, fills in a title, description, free sample, private note and files (or clicks **Use sample deliverable**), then clicks **Encrypt & create 1 CKB invoice**.
2. The generated **offer JSON** is public. It holds the preview, the file hashes, the ciphertext and the invoice, but not the key and not the files.
3. **Client** starts a node, pastes the offer, clicks **Validate offer**, and sees the preview card: description, free sample, locked file list with hashes.
4. **Try to open without paying** shows the content stays locked.
5. **Pay 1 CKB** routes the payment through Bottle. The settled payment returns the preimage.
6. **Unlock with revealed key** decrypts the bundle. Each file shows *hash matches* or *HASH MISMATCH*, can be downloaded, and text files are previewed inline.

## What I changed from the starter

The node startup, channel handling, payment submission, retry safety and resume logic are unchanged. The starter encrypted one text string. I changed what gets encrypted, what the client sees before paying, and what happens after unlocking.

| File | Change |
| --- | --- |
| `lib/deliverable.ts` (new) | Bundles files and a private note into the encrypted payload. Builds the public preview with a SHA-256 manifest. Validates untrusted previews. After unlock, verifies every file against the manifest and reports mismatches or missing files. |
| `lib/demo-deliverable.ts` (new) | A sample handover (a report and a CSV) so the demo needs no file hunting. Figures in it are illustrative. |
| `lib/offer.ts` | Offer is now `version: 3` and carries a validated `preview`. `createOffer` takes the bundle instead of a string. Old v2 offers are rejected with a clear message. |
| `app/page.tsx` | Seller form with file picker. Client-side preview card. Delivered-files view with hash verification, per-file download and inline text preview. Buyer/Seller relabelled Client/Freelancer. |
| `app/globals.css` | Styles for the new form, file list and verification states. |
| `deliverable.test.mjs` (new) | 8 tests: round trip with binary data, wrong key rejected, tampered file flagged, missing file reported, input limits, filename safety, untrusted preview validation. |
| `package.json` | Renamed; `npm test` runs both test files. |
| `README.starter.md` | The original starter README, kept for the troubleshooting notes. |

## Run it

Node.js 22.18 or newer and npm.

```sh
npm install
npm run dev
```

Open http://localhost:3001 (use `localhost` or HTTPS; the WASM runtime needs cross-origin isolation, which `next.config.mjs` provides). Start both nodes, fund each from the [faucet](https://faucet.nervos.org), open both channels and wait for `CHANNEL_READY`. Then follow the flow above. Setup, resume and troubleshooting details are in `README.starter.md`; they apply unchanged.

```sh
npm run typecheck
npm test
npm run build
```

## Trust model and limits

- **The payment reveals the key.** That is the whole mechanism. Until the payment settles, the client cannot decrypt.
- **The hashes prove consistency, not quality.** After unlocking, the client can prove they received exactly the files that were advertised. They cannot prove the files are *good*. A dishonest seller could advertise hashes of junk. This is "pay to unlock what you were shown", not escrow, and it has no dispute handling.
- **Demo limits.** Price is fixed at 1 CKB. A bundle is capped at 100 KB across up to 8 files, because the offer is copied and pasted as JSON. Testnet only.
- **Nothing secret is stored.** As in the starter, AES keys and decrypted files are never saved by the app; the key is recovered from the settled payment via `getPayment`.

## Demo evidence

[Watch the demo recording](https://drive.google.com/file/d/1-6vmYhBo-HiI1iaOm7YhUrqrAzcEK2Y4/view?usp=sharing).
