/** Own automatic probes and complete delivery without revoking manual owners (PRD §13.3, C-SITE-03). */
export class AutomaticPreparation {
  constructor(scene) {
    this.scene = scene;
    this.preparationOwner = null;
  }
  current(preparationOwner) {
    return (
      this.preparationOwner === preparationOwner &&
      this.scene.director.task === preparationOwner.task &&
      !this.scene.bank.disposed
    );
  }
  ensureOwner(task, name) {
    if (task !== this.scene.director.task || this.scene.bank.disposed) return null;
    if (this.scene.bank.hasAnimationFailure(name)) {
      this.scene.director.rest();
      return null;
    }
    this.preparationOwner ??= { task, name, controller: new AbortController() };
    return this.preparationOwner;
  }
  cancel(task) {
    const preparationOwner = this.preparationOwner;
    if (!preparationOwner || preparationOwner.task !== task) return;
    this.preparationOwner = null;
    preparationOwner.controller.abort();
    const { bank, world } = this.scene;
    const animations = bank.animations;
    if (!preparationOwner.animationOwner) return;
    if (animations.deliveredOwner === preparationOwner.animationOwner) {
      const queued = world.player.queuedAction;
      const name = queued?.gesture ?? (queued?.face ? `idle-${queued.face}` : null);
      if (name === preparationOwner.name) world.player.queuedAction = null;
    }
    if (
      animations.candidateOwner === preparationOwner.animationOwner ||
      animations.deliveredOwner === preparationOwner.animationOwner
    ) {
      bank.cancelPreparation();
    }
  }
  fail(preparationOwner, error) {
    if (!this.current(preparationOwner)) return;
    this.scene.director.rest();
    this.scene.onError?.(error);
  }
  requestMetadata(name, task) {
    const preparationOwner = this.ensureOwner(task, name);
    if (!preparationOwner || preparationOwner.metadataRequested) return;
    preparationOwner.metadataRequested = true;
    this.scene.bank
      .load(name, { signal: preparationOwner.controller.signal })
      .catch((error) => this.fail(preparationOwner, error));
  }
  publish(preparationOwner) {
    const { bank } = this.scene;
    const animations = bank.animations;
    if (
      animations.candidateOwner === preparationOwner.animationOwner &&
      preparationOwner.animationOwner.ready
    ) {
      bank.publishAnimation(preparationOwner.name);
      return animations.deliveredOwner === preparationOwner.animationOwner;
    }
    const activeOwner = animations.activeOwner;
    if (
      activeOwner === preparationOwner.animationOwner &&
      !animations.candidateOwner &&
      !animations.deliveredOwner &&
      ["idle", "rotation", preparationOwner.name].every((name) => activeOwner.clips.has(name))
    ) {
      return true;
    }
    this.scene.director.rest();
    return false;
  }
  ensureDeliveryReady(name, task) {
    const preparationOwner = this.ensureOwner(task, name);
    if (!preparationOwner) return false;
    if (preparationOwner.ready) return this.publish(preparationOwner);
    if (!preparationOwner.pending) {
      preparationOwner.pending = true;
      const pending = this.scene.bank.prepareAnimation(name);
      preparationOwner.animationOwner =
        this.scene.bank.animations.candidateOwner ?? this.scene.bank.animations.activeOwner;
      pending
        .then((clip) => {
          if (!this.current(preparationOwner)) return;
          if (clip) preparationOwner.ready = true;
          else this.scene.director.rest();
        })
        .catch((error) => this.fail(preparationOwner, error));
    }
    return false;
  }
}
