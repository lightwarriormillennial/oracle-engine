/**
 * DashboardGateway — real-time WebSocket dashboard via Socket.io.
 */
import { WebSocketGateway, WebSocketServer, SubscribeMessage } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({ cors: true, namespace: 'dashboard' })
export class DashboardGateway {
  private readonly logger = new Logger(DashboardGateway.name);
  @WebSocketServer()
   server!: Server;

  broadcastState(state: any): void {
    this.server?.emit('engine:state', { timestamp: Date.now(), ...state });
  }

  @SubscribeMessage('subscribe')
  handleSubscription(client: any): void {
    this.logger.log(`Dashboard client subscribed: ${client.id}`);
    client.join('engine');
  }
}
