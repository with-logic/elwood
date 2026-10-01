/** Deliver complete pickup only to its current drag (PRD §13.4, C-SITE-04). */
export function prepareDrag(scene, drag) {
  const version = scene.requestVersion;
  const current = () => scene.drag === drag && scene.requestVersion === version && !scene.bank.disposed;
  const { bank } = scene;
  const pending = bank.prepareAnimation(drag.name);
  const owner = bank.animations.candidateOwner ?? bank.animations.activeOwner;
  pending.then((clip) => {
    if (!clip || !current()) return;
    if (bank.animations.candidateOwner === owner) bank.publishAnimation(drag.name);
    else if (bank.animations.activeOwner !== owner || bank.animations.candidateOwner || bank.animations.deliveredOwner) return;
    scene.world.animate(drag.name, true);
    bank.activateAnimation(drag.name);
  }).catch((error) => { if (current()) scene.onError?.(error); });
}
