/** aria props for a control wrapped in <Field id={id}>: matches the ids Field gives its error/hint text. */
export function fieldA11y(id: string, error?: string, hasHint = false) {
  return {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : hasHint ? `${id}-hint` : undefined,
  } as const;
}
