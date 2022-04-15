import { BookingStatus } from "@prisma/client";
import { VitalClient } from "@tryvital/vital-node";
import dayjs from "dayjs";
import type { NextApiRequest, NextApiResponse } from "next";
import queue from "queue";

import { IS_PRODUCTION } from "@calcom/lib/constants";
import { getErrorFromUnknown } from "@calcom/lib/errors";
import { HttpError as HttpCode } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import prisma from "@calcom/prisma";

import { Reschedule } from "../lib";

const client = new VitalClient({
  client_id: process.env.VITAL_CLIENT_ID || "",
  client_secret: process.env.VITAL_CLIENT_SECRET || "",
  // @ts-ignore
  environment: process.env.VITAL_DEVELOPMENT_MODE || "sandbox",
});

// @Note: not being used anymore but left as example
const getOuraSleepScore = async (user_id: string, bedtime_start: Date) => {
  const sleep_data = await client.Sleep.get_raw(user_id, bedtime_start, undefined, "oura");
  if (sleep_data.sleep.length === 0) {
    throw Error("No sleep score found");
  }
  return +sleep_data.sleep[0].data.score;
};

/**
 * This is will generate a user token for a client_user_id`
 * @param req
 * @param res
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      throw new HttpCode({ statusCode: 405, message: "Method Not Allowed" });
    }
    const sig = req.headers["svix-signature"];
    if (!sig) {
      throw new HttpCode({ statusCode: 400, message: "Missing svix-signature" });
    }

    const payload = JSON.stringify(req.body);

    const event: any = client.Webhooks.constructWebhookEvent(
      payload,
      req.headers as Record<string, string>,
      process.env.VITAL_WEBHOOK_SECRET as string
    );

    if (event.event_type == "daily.data.sleep.created") {
      // Carry out logic here to determine what to do if sleep is less
      // than 8 hours or readiness score is less than 70
      try {
        // Getting total hours of sleep seconds/60/60 = hours
        const minimumSleepTime = 5;
        const totalHoursSleep = event.data.duration / 60 / 60;
        if (totalHoursSleep < minimumSleepTime) {
          // Trigger reschedule
          try {
            const todayDate = dayjs();
            const todayBookings = await prisma.booking.findMany({
              where: {
                startTime: {
                  gte: todayDate.startOf("day").toISOString(),
                },
                endTime: {
                  lte: todayDate.endOf("day").toISOString(),
                },
                status: {
                  in: [BookingStatus.ACCEPTED, BookingStatus.PENDING],
                },
              },
              select: {
                id: true,
                uid: true,
                status: true,
              },
            });
            // const [booking] = todayBookings;
            const q = queue({ results: [] });
            if (todayBookings.length > 0) {
              todayBookings.forEach((booking) =>
                q.push(() => {
                  return Reschedule(booking.uid, "Can't do it");
                })
              );
            }
            await q.start();
          } catch (error) {
            throw new Error("Failed to reschedule bookings");
          }
        }
      } catch (error) {
        if (error instanceof Error) {
          logger.error(error.message);
        }
        logger.error("Failed to get sleep score");
      }
    }
    return res.status(200).json({ body: req.body });
  } catch (_err) {
    const err = getErrorFromUnknown(_err);
    console.error(`Webhook Error: ${err.message}`);
    res.status(err.statusCode ?? 500).send({
      message: err.message,
      stack: IS_PRODUCTION ? undefined : err.stack,
    });
    return;
  }
}
