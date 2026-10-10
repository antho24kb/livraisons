// Fonction « notifier » : lancée toutes les 3 h par le planificateur Supabase.
// Vérifie les colis de tous les utilisateurs via Ship24 et envoie une notification push quand le statut avance.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const STATUT: Record<string, string> = {
  pending: 'commande', info_received: 'commande', in_transit: 'expedie',
  out_for_delivery: 'livraison', available_for_pickup: 'livraison',
  failed_attempt: 'livraison', exception: 'expedie', delivered: 'livraison',
};
const MSG: Record<string, string> = {
  expedie: 'est expédié 📦', livraison: 'est en cours de livraison 🚚', recu: 'est livré ✅',
};
const cle = (r: { recu: boolean; statut: string }) => (r.recu ? 'recu' : r.statut);

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('interdit', { status: 403 });
  }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  webpush.setVapidDetails('mailto:antho24kb@hotmail.fr', Deno.env.get('VAPID_PUBLIC')!, Deno.env.get('VAPID_PRIVATE')!);
  const ship = Deno.env.get('SHIP24_KEY')!;

  // 1) rafraîchir les colis non reçus (max 20 par passage)
  const { data: aVerifier } = await sb.from('colis').select('id,suivi').eq('recu', false).neq('suivi', '')
    .order('derniere_maj', { ascending: true, nullsFirst: true }).limit(20);
  for (const r of aVerifier ?? []) {
    try {
      const res = await fetch('https://api.ship24.com/public/v1/trackers/track', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ship}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingNumber: String(r.suivi).trim() }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) continue;
      const t = (await res.json())?.data?.trackings?.[0];
      const jalon: string | undefined = t?.shipment?.statusMilestone;
      const ev = t?.events?.[0];
      const patch: Record<string, unknown> = { derniere_maj: new Date().toISOString() };
      if (jalon && STATUT[jalon]) patch.statut = STATUT[jalon];
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
      await sb.from('colis').update(patch).eq('id', r.id);
    } catch (_) { /* prochain passage */ }
  }

  // 2) notifier les changements pas encore signalés
  const { data: tous } = await sb.from('colis').select('id,user_id,article,statut,recu,notif_cle').neq('suivi', '');
  let envoyes = 0;
  for (const c of tous ?? []) {
    const k = cle(c);
    if (k === c.notif_cle) continue;
    await sb.from('colis').update({ notif_cle: k }).eq('id', c.id);
    if (!MSG[k]) continue;
    const { data: pref } = await sb.from('prefs').select('mail').eq('user_id', c.user_id).maybeSingle();
    if (pref?.mail && Deno.env.get('RESEND_KEY') && Deno.env.get('MAIL_TO')) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${Deno.env.get('RESEND_KEY')}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Livraisons <onboarding@resend.dev>',
            to: [Deno.env.get('MAIL_TO')],
            subject: `${c.article} ${MSG[k]}`,
            text: `${c.article} ${MSG[k]}\n\nOuvre l'appli : https://antho24kb.github.io/livraisons/`,
          }),
        });
        if (r.ok) envoyes++;
      } catch (_) { /* tant pis */ }
    }
    const { data: subs } = await sb.from('push_subs').select('*').eq('user_id', c.user_id);
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: 'Livraisons', body: `${c.article} ${MSG[k]}`, tag: c.id }),
        );
        envoyes++;
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404 || (e as { statusCode?: number }).statusCode === 410) {
          await sb.from('push_subs').delete().eq('id', s.id);
        }
      }
    }
  }
  return new Response(JSON.stringify({ envoyes }), { headers: { 'Content-Type': 'application/json' } });
});
