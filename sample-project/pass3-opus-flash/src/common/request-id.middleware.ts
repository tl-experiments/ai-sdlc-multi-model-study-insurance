import { Injectable, NestMiddleware } from "@nestjs/common";
import { v4 as uuid } from "uuid";

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void): void {
    const incoming = req.headers["x-request-id"];
    req.id = typeof incoming === "string" && incoming ? incoming : uuid();
    res.setHeader("X-Request-Id", req.id);
    next();
  }
}
