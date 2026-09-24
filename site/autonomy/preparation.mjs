/** Own automatic probes and complete delivery without revoking manual owners (PRD §13.3, C-SITE-03). */
export class AutomaticPreparation {
  constructor(scene) {
    this.scene = scene;
    this.owner = null;
  }
  current(owner) {
    return (
      this.owner === owner &&
      this.scene.director.task === owner.task &&
      !this.scene.bank.disposed
    );
  }
  state(task, name) {
    if (task !== this.scene.director.task || this.scene.bank.disposed) return null;
    if (this.scene.bank.loads.failed.has(name)) {
      this.scene.director.rest();
      return null;
    }
    return this.owner ??= { task, name, controller: new AbortController() };
  }
  cancel(task) {
    const owner = this.owner;
    if (!owner || owner.task !== task) return;
    this.owner = null;
    owner.controller.abort();
    const { bank, world } = this.scene;
    const animations = bank.animations;
    if (!owner.animation) return;
    if (animations.deliveredOwner === owner.animation) {
      const queued = world.player.queuedAction;
      const name = queued?.gesture ?? (queued?.face ? `idle-${queued.face}` : null);
      if (name === owner.name) world.player.queuedAction = null;
    }
    if (
      animations.candidateOwner === owner.animation ||
      animations.deliveredOwner === owner.animation
    ) {
      bank.cancelPreparation();
    }
  }
  fail(owner, error) {
    if (!this.current(owner)) return;
    this.scene.bank.loads.failed.add(owner.name);
    this.scene.director.rest();
    this.scene.onError?.(error);
  }
  metadata(name, task) {
    const owner = this.state(task, name);
    if (!owner || owner.metadataRequested) return;
    owner.metadataRequested = true;
    this.scene.bank
      .load(name, { signal: owner.controller.signal })
      .catch((error) => this.fail(owner, error));
  }
  publish(owner) {
    const { bank } = this.scene;
    const animations = bank.animations;
    if (animations.candidateOwner === owner.animation && owner.animation.ready) {
      bank.publishAnimation(owner.name);
      return animations.deliveredOwner === owner.animation;
    }
    const active = animations.activeOwner;
    if (
      active === owner.animation &&
      !animations.candidateOwner &&
      !animations.deliveredOwner &&
      ["idle", "rotation", owner.name].every((name) => active.clips.has(name))
    ) {
      return true;
    }
    this.scene.director.rest();
    return false;
  }
  ready(name, task) {
    const owner = this.state(task, name);
    if (!owner) return false;
    if (owner.ready) return this.publish(owner);
    if (!owner.pending) {
      owner.pending = true;
      const pending = this.scene.bank.prepareAnimation(name);
      owner.animation =
        this.scene.bank.animations.candidateOwner ?? this.scene.bank.animations.activeOwner;
      pending
        .then((clip) => {
          if (!this.current(owner)) return;
          if (clip) owner.ready = true;
          else this.scene.director.rest();
        })
        .catch((error) => this.fail(owner, error));
    }
    return false;
  }
}
