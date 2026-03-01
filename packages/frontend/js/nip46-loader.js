import { generateSecretKey, getPublicKey } from 'https://esm.sh/nostr-tools@2.23.1/pure';
import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from 'https://esm.sh/nostr-tools@2.23.1/nip46';
import { SimplePool } from 'https://esm.sh/nostr-tools@2.23.1/pool';
window.NostrNIP46 = {
  generateSecretKey,
  getPublicKey,
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  SimplePool,
  loaded: true
};
window.dispatchEvent(new Event('nip46-ready'));
