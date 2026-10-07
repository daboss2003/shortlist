"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Submit button for the enclosing <form>: disabled with a spinner and `pendingLabel` while the action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, "type"> & { pendingLabel: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending && <Loader2 className="animate-spin" aria-hidden />}
      {pending ? pendingLabel : children}
    </Button>
  );
}
