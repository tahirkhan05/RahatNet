import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { AssignmentStatus, COLLECTIONS } from '@rahatnet/types';
import type { CanonicalNeed, VolunteerProfile } from '@rahatnet/types';

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const onNeedAssigned = onDocumentCreated(
  { document: `${COLLECTIONS.ASSIGNMENTS}/{assignmentId}`, region: 'asia-south1' },
  async (event) => {
    const assignment = event.data?.data();
    if (!assignment) return;

    const db = getFirestore();
    const messaging = getMessaging();

    const volunteerSnap = await db
      .collection(COLLECTIONS.USERS)
      .doc(assignment.volunteerId as string)
      .get();

    const volunteer = volunteerSnap.data() as VolunteerProfile | undefined;
    if (!volunteer?.fcmToken) return;

    const needSnap = await db
      .collection(COLLECTIONS.NEEDS)
      .doc(assignment.needId as string)
      .get();

    const need = needSnap.data() as CanonicalNeed | undefined;
    if (!need) return;

    try {
      await messaging.send({
        token: volunteer.fcmToken,
        notification: {
          title: `New Task: ${need.type}`,
          body: `${need.title} — ${need.locationName}`,
        },
        data: {
          type: 'TASK_ASSIGNED',
          assignmentId: event.params['assignmentId'] ?? '',
          needId: assignment.needId as string,
          needType: need.type,
          locationName: need.locationName,
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'tasks',
            priority: 'max',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      });

      await db.collection(COLLECTIONS.ASSIGNMENTS).doc(event.params['assignmentId'] ?? '').update({
        status: AssignmentStatus.NOTIFIED,
      });
    } catch (err) {
      console.error('Failed to send task notification:', err);
    }
  },
);
