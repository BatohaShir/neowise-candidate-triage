// What the manager sees for an API answer. Shared by the page and the tests.
export const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цена", other: "Другое" };

export const MESSAGES = {
  empty: "Введите текст заявки.",
  manual: "AI не смог разобрать заявку. Разберите её вручную: определите тему и напишите ответ сами.",
};

export function viewFor(httpStatus, body) {
  if (
    httpStatus === 200 &&
    body?.status === "ready" &&
    Object.hasOwn(TOPIC_LABELS, body.topic) &&
    typeof body.draft === "string" &&
    body.draft.trim() !== ""
  ) {
    return { kind: "ready", topic: TOPIC_LABELS[body.topic], draft: body.draft, message: "" };
  }
  if (httpStatus === 400 || body?.status === "invalid_input") {
    return { kind: "invalid", topic: "", draft: "", message: MESSAGES.empty };
  }
  // manual_review, server error, network failure or anything unexpected:
  // never leave an old draft on screen.
  return { kind: "manual", topic: "", draft: "", message: MESSAGES.manual };
}
