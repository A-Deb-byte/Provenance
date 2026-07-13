import express from 'express';
import type { SecretVault } from './dpapi';

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unknown vault error.'
);

/**
 * Vault API. Secret values may be written but are never returned: responses
 * expose only names and status. Reads of the plaintext happen in-process for
 * environment injection, never over the wire.
 */
export const createVaultApi = (vault: SecretVault) => {
  const router = express.Router();

  router.get('/status', async (_req, res) => {
    try {
      res.json(await vault.getStatus());
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  router.get('/secrets', async (_req, res) => {
    try {
      res.json({ secretNames: await vault.list() });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  router.put('/secrets/:name', async (req, res) => {
    const value = req.body?.value as unknown;
    if (typeof value !== 'string' || value.length === 0) {
      res.status(400).json({ error: 'Secret value must be a non-empty string.' });
      return;
    }
    try {
      await vault.store(req.params.name, value);
      res.status(204).end();
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.includes('unavailable') ? 503 : 400).json({ error: message });
    }
  });

  router.delete('/secrets/:name', async (req, res) => {
    try {
      const removed = await vault.remove(req.params.name);
      res.status(removed ? 204 : 404).end();
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  return router;
};
