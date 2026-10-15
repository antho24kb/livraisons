// Fonction « notifier » : lancée toutes les heures par le planificateur Supabase.
// 1) rafraîchit le suivi (Ship24), 2) alerte les changements de statut, 3) alerte les retards.
// Respecte les réglages de chaque utilisateur (table prefs) : alertes choisies et mode « ne pas déranger ».
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
const ALERTE: Record<string, string> = { expedie: 'alert_expedie', livraison: 'alert_livraison', recu: 'alert_livre' };
const DEFAUT = {
  mail: false, alert_expedie: true, alert_livraison: true, alert_livre: true, alert_retard: true,
  silence_on: false,
};
// Mondial Relay : le n° d'expédition seul ne suffit pas, il faut le code postal de livraison.
const CP_MONDIAL = '38530';
const corpsSuivi = (r: { suivi: unknown; transporteur?: string | null }) => ({
  trackingNumber: String(r.suivi).trim(),
  ...(r.transporteur === 'mondial' ? { destinationPostCode: CP_MONDIAL } : {}),
});
const cle = (r: { recu: boolean; statut: string }) => (r.recu ? 'recu' : r.statut);
const heureParis = () =>
  Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const dateParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
const enSilence = (h: number, d: number, f: number) => (d === f ? false : d < f ? h >= d && h < f : h >= d || h < f);

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('interdit', { status: 403 });
  }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  webpush.setVapidDetails('mailto:antho24kb@hotmail.fr', Deno.env.get('VAPID_PUBLIC')!, Deno.env.get('VAPID_PRIVATE')!);
  const ship = Deno.env.get('SHIP24_KEY')!;
  const heure = heureParis();
  const aujourdhui = dateParis();

  const { data: lignes } = await sb.from('prefs').select('*');
  const prefs = new Map((lignes ?? []).map((p) => [p.user_id as string, p]));
  // deno-lint-ignore no-explicit-any
  const pref = (uid: string): any => ({ ...DEFAUT, ...(prefs.get(uid) ?? {}) });

  let envoyes = 0;
  async function envoyer(uid: string, titre: string, corps: string, tag: string) {
    const p = pref(uid);
    const resend = Deno.env.get('RESEND_KEY');
    const dest = Deno.env.get('MAIL_TO');
    if (p.mail && resend && dest) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resend}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Colizy <onboarding@resend.dev>',
            to: [dest],
            subject: corps,
            text: `${corps}\n\nOuvre l'appli : https://antho24kb.github.io/livraisons/`,
          }),
        });
        if (r.ok) envoyes++;
      } catch (_) { /* tant pis */ }
    }
    const { data: subs } = await sb.from('push_subs').select('*').eq('user_id', uid);
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: titre, body: corps, tag }),
        );
        envoyes++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.from('push_subs').delete().eq('id', s.id);
      }
    }
  }

  // 1) rafraîchir le suivi : colis non reçus pas vérifiés depuis 3 h (max 20 par passage)
  const limite = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const { data: aVerifier } = await sb.from('colis').select('id,suivi,transporteur').eq('recu', false).neq('suivi', '')
    .or(`derniere_maj.is.null,derniere_maj.lt.${limite}`)
    .order('derniere_maj', { ascending: true, nullsFirst: true }).limit(20);
  for (const r of aVerifier ?? []) {
    try {
      const res = await fetch('https://api.ship24.com/public/v1/trackers/track', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ship}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpsSuivi(r)),
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

  // 2) changements de statut pas encore signalés
  const { data: tous } = await sb.from('colis').select('id,user_id,article,statut,recu,notif_cle').neq('suivi', '');
  for (const c of tous ?? []) {
    const k = cle(c);
    if (k === c.notif_cle) continue;
    const p = pref(c.user_id);
    if (!MSG[k] || p[ALERTE[k]] === false) {
      await sb.from('colis').update({ notif_cle: k }).eq('id', c.id);
      continue;
    }
    if (p.silence_on) continue; // ne pas déranger : l'alerte reste en attente
    await sb.from('colis').update({ notif_cle: k }).eq('id', c.id);
    await envoyer(c.user_id, 'Colizy', `${c.article} ${MSG[k]}`, c.id);
  }

  // 3) retards (une seule alerte par colis)
  const { data: retards } = await sb.from('colis').select('id,user_id,article')
    .eq('recu', false).lt('date_prevue', aujourdhui).is('retard_notifie', null);
  for (const c of retards ?? []) {
    const p = pref(c.user_id);
    if (p.alert_retard === false) {
      await sb.from('colis').update({ retard_notifie: aujourdhui }).eq('id', c.id);
      continue;
    }
    if (p.silence_on) continue; // ne pas déranger
    await sb.from('colis').update({ retard_notifie: aujourdhui }).eq('id', c.id);
    await envoyer(c.user_id, 'Colizy', `${c.article} est en retard ⏰`, `retard-${c.id}`);
  }

  return new Response(JSON.stringify({ envoyes }), { headers: { 'Content-Type': 'application/json' } });
});
