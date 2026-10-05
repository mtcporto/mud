export function createSecretRedactor(secret, write) {
  let value = String(secret || '');
  let pending = '';

  function emit(flush) {
    while (pending) {
      if (value && pending.startsWith(value)) {
        write('[password echo hidden]');
        pending = pending.slice(value.length);
      } else if (!flush && value.startsWith(pending)) {
        return;
      } else {
        write(pending[0]);
        pending = pending.slice(1);
      }
    }
  }

  return {
    write(text) {
      pending += text;
      emit(false);
    },
    flush() {
      if (pending && value.startsWith(pending)) {
        write('[password echo hidden]');
        pending = '';
      }
      emit(true);
      value = '';
    },
  };
}
