// Fonction Supabase « maj-suivi » : met à jour l'état des colis de l'utilisateur connecté via Ship24.
// La clé Ship24 est lue dans le secret SHIP24_KEY (jamais dans le code ni dans l'appli).
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Jalons Ship24 -> statuts de l'appli
const STATUT: Record<string, string> = {
  pending: 'commande',
  info_received: 'commande',
  in_transit: 'expedie',
  out_for_delivery: 'livraison',
  available_for_pickup: 'livraison',
  failed_attempt: 'livraison',
  exception: 'expedie',
  delivered: 'livraison',
};
const DELAI_MS = 3 * 3600 * 1000; // pas plus d'un appel toutes les 3 h par colis
const MAX_PAR_APPEL = 5;
const RANG: Record<string, number> = { commande: 0, expedie: 1, livraison: 2 };
// Mondial Relay : le n° d'expédition seul ne suffit pas, il faut le code postal de livraison.
const CP_MONDIAL = '38530';
const corpsSuivi = (r: { suivi: unknown; transporteur?: string | null }) => ({
  trackingNumber: String(r.suivi).trim(),
  ...(r.transporteur === 'mondial' ? { destinationPostCode: CP_MONDIAL } : {}),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: u } = await sb.auth.getUser();
  if (!u?.user) return json({ error: 'non connecté' }, 401);

  const cle = Deno.env.get('SHIP24_KEY');
  if (!cle) return json({ error: 'SHIP24_KEY manquante' }, 500);

  const { data: rows, error } = await sb
    .from('colis')
    .select('id,suivi,transporteur,statut,derniere_maj')
    .eq('recu', false)
    .neq('suivi', '');
  if (error) return json({ error: error.message }, 500);

  const now = Date.now();
  const dus = (rows ?? [])
    .filter((r) => !r.derniere_maj || now - new Date(r.derniere_maj).getTime() > DELAI_MS)
    .slice(0, MAX_PAR_APPEL);

  let maj = 0;
  await Promise.all(dus.map(async (r) => {
    try {
      // Le corps ne contient que le numéro (+ code postal pour Mondial Relay) : un corps identique réutilise le même suivi chez Ship24.
      const res = await fetch('https://api.ship24.com/public/v1/trackers/track', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cle}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpsSuivi(r)),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) return;
      const j = await res.json();
      const t = j?.data?.trackings?.[0];
      const jalon: string | undefined = t?.shipment?.statusMilestone;
      const ev = t?.events?.[0];
      const patch: Record<string, unknown> = { derniere_maj: new Date().toISOString() };
      // le statut ne recule jamais (Ship24 peut renvoyer une info moins avancée d'un contrôle à l'autre)
      if (jalon && STATUT[jalon] && (RANG[STATUT[jalon]] ?? 0) >= (RANG[r.statut] ?? 0)) patch.statut = STATUT[jalon];
      const estimee = t?.shipment?.delivery?.estimatedDeliveryDate ?? t?.shipment?.delivery?.courierEstimatedDeliveryDate;
      if (estimee) patch.livraison_estimee = estimee;
      if (jalon === 'delivered') {
        patch.recu = true;
        patch.recu_le = (ev?.occurrenceDatetime ?? new Date().toISOString()).slice(0, 10);
      }
      if (ev) {
        const quand = ev.occurrenceDatetime ? ev.occurrenceDatetime.slice(0, 10) : '';
        patch.dernier_evenement = [ev.status, ev.location, quand].filter(Boolean).join(' · ').slice(0, 300);
      }
      const { error: e2 } = await sb.from('colis').update(patch).eq('id', r.id);
      if (!e2) maj++;
    } catch (_) { /* on réessaiera plus tard */ }
  }));

  return json({ verifies: dus.length, maj });
});
