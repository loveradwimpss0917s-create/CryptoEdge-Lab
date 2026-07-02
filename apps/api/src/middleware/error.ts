import type { ErrorHandler } from "hono";
import { ZodError } from "zod";

/** RFC 9457 Problem Details error responses (docs/08 header conventions). */
export const problemDetailsErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ZodError) {
    return c.json(
      {
        type: "about:blank",
        title: "validation failed",
        status: 400,
        errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
      },
      400
    );
  }
  console.error(err);
  return c.json({ type: "about:blank", title: "internal server error", status: 500 }, 500);
};
