import { generateSecretKey, getPublicKey, finalizeEvent } from 'https://esm.sh/nostr-tools@2.23.1/pure';
import { decode, nsecEncode, npubEncode } from 'https://esm.sh/nostr-tools@2.23.1/nip19';
import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from 'https://esm.sh/nostr-tools@2.23.1/nip46';
import { SimplePool } from 'https://esm.sh/nostr-tools@2.23.1/pool';
window.NostrNIP46 = {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  decode,
  nsecEncode,
  npubEncode,
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  SimplePool,
  loaded: true
};
window.dispatchEvent(new Event('nip46-ready'));
