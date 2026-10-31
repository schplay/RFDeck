import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { CloudService } from '../cloud/service';
import { CloudLoginError } from '../cloud/cloudUser';
import { isLoopback } from '../auth/pinAuth';

/**
 * Signing a Meros cloud user in on this install, for Manifold.
 *
 *   POST /api/auth/cloud-login/begin      → { requestId, codeChallenge, codeChallengeMethod, nonce, expiresIn }
 *   POST /api/auth/cloud-login/complete   { requestId, loginToken } → the session
 *   GET  /api/auth/cloud-session          → the session
 *   POST /api/auth/cloud-signout          → { signedIn: false, revoked }
 *
 * All four sit behind the PIN gate like every other route: the PIN authorises the
 * *connection* (Manifold already holds a PIN token), and this adds an identity on
 * top. See `cloud/cloudUser.ts` for the flow and why it is shaped this way.
 *
 * **HTTPS only, loopback excepted.** A login token redeems into a year of access to
 * somebody's cloud account. RFDeck always serves HTTPS now, so this refusal should
 * never fire; it is here so that it cannot quietly become possible again.
 */
export const cloudLoginRoutes: FastifyPluginAsync = async (fastify) => {
  const service = () => (fastify as any).cloud as CloudService | undefined;

  /** The cloud-user login, or a reply already sent explaining why there is none. */
  const guard = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.protocol !== 'https' && !isLoopback(request.ip)) {
      void reply.code(403).send({
        error: 'https_required',
        message: 'Cloud sign-in is only available over HTTPS.',
      });
      return null;
    }
    const login = service()?.cloudUser;
    if (!login) {
      void reply.code(503).send({
        error: 'not_configured',
        message: 'Meros Cloud is not configured on this server.',
      });
      return null;
    }
    return login;
  };

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof CloudLoginError) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    throw err;
  };

  fastify.post('/auth/cloud-login/begin', async (request, reply) => {
    const login = guard(request, reply);
    if (!login) return reply;
    try {
      return await login.begin();
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post('/auth/cloud-login/complete', async (request, reply) => {
    const login = guard(request, reply);
    if (!login) return reply;
    const { requestId, loginToken } = (request.body ?? {}) as { requestId?: unknown; loginToken?: unknown };
    if (typeof requestId !== 'string' || !requestId || typeof loginToken !== 'string' || !loginToken) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'requestId and loginToken are both required.',
      });
    }
    try {
      return await login.complete(requestId, loginToken);
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get('/auth/cloud-session', async (request, reply) => {
    const login = guard(request, reply);
    if (!login) return reply;
    return { configured: !!login.clientId, ...(await login.session()) };
  });

  fastify.post('/auth/cloud-signout', async (request, reply) => {
    const login = guard(request, reply);
    if (!login) return reply;
    try {
      return await login.signOut();
    } catch (err) {
      return fail(reply, err);
    }
  });
};
