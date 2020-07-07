import OnReceiverMessageListener from "../websocket/listener/onReceiverMessageListener";
import ChatManager from "../websocket/chatManager";
import CallStartMessageContent from "./message/callStartMessageContent";
import CallSession from "./callSession";
import CallState from "./callState";
import SendMessage from "../websocket/message/sendMessage";
import CallAnswerMessageContent from "./message/callAnswerMessageContent";
import CallSignalMessageContent from "./message/callSignalMessageContent";
import CallByeMessageContent from "./message/callByeMessageContent";
import CallEndReason from "./callEndReason";
import Participant from "./participant";
import kurentoUtils from "kurento-utils"
import MessageConfig from '../websocket/message/messageConfig'
import LocalStore from "../websocket/store/localstore";

export default class GroupCallClient extends OnReceiverMessageListener {
    currentSession;
    currentSessionCallback;
    currentEngineCallback;
    //是否群组聊天发起人
    isInitiator;
    participants = {};

    constructor(store){
        super();
        this.store = store;
        ChatManager.addReceiveMessageListener(this);
    }

    setCurrentSessionCallback(sessionCallback){
        this.currentSessionCallback = sessionCallback;
    }
 
    setCurrentEngineCallback(engineCallback){
         this.currentEngineCallback = engineCallback;
    }

    /**
     * 开始群组音视频通话
     * @param target 群组会话target
     * @param tos 邀请的用户target 数组列表
     * @param isAudioOnly 是否仅仅是音频聊天
     */
    startCall(target,tos,isAudioOnly){
        this.isInitiator = true;
        //创建session
        var newSession = this.newSession(target,isAudioOnly,target + new Date().getTime());
        newSession.setState(CallState.STATUS_OUTGOING);
        this.currentSession = newSession;
        console.log("create new session "+this.currentSession.clientId+" callId "+this.currentSession.callId);
        //发送callmessage
        var callStartMessageContent = new CallStartMessageContent(newSession.callId,target,isAudioOnly);
        this.sendMessage(target,callStartMessageContent,tos);
    }


    answerCall(audioOnly){
      this.isInitiator = false;
      console.log("isInitiator "+this.isInitiator);
      this.currentSession.setState(CallState.STATUS_CONNECTING);
      var answerMesage = new CallAnswerMessageContent()
      answerMesage.isAudioOnly = audioOnly;
      answerMesage.callId = this.currentSession.callId;
      this.sendMessage(this.currentSession.clientId,answerMesage);
  }

    /**
     * 群组成员离开音视频通话
     */
    leaveCall(){

    }

    /**
     * 结束群组音视频通话
     */
    endCall(){

    }

    onReceiveMessage(protoMessage){
      console.log(" receive message "+protoMessage.direction)
        if(new Date().getTime() - protoMessage.timestamp < 90000 && protoMessage.direction === 1){
          let contentClazz = MessageConfig.getMessageContentClazz(protoMessage.content.type);
          if(contentClazz){
            let content = new contentClazz();
            try {
                content.decode(protoMessage.content);
            } catch(err){
              console.log('decode error');
            }
            if(this.currentSession){
              console.log("current call state "+this.currentSession.callState);
            }
            if(content instanceof CallStartMessageContent){
              console.log("receive call startmessage");
              if(this.currentSession && this.currentSession.callState !== CallState.STATUS_IDLE){
                this.rejectOtherCall(content.callId,protoMessage.from);
              } else {
                this.currentSession = this.newSession(protoMessage.from,content.audioOnly,content.callId);
                this.currentSession.setState(CallState.STATUS_INCOMING);
                this.currentEngineCallback.onReceiveCall(this.currentSession);
              }
              
            } else if(content instanceof CallSignalMessageContent){
              if(this.currentSession && this.currentSession.callState != CallState.STATUS_IDLE){
                console.log("current state "+this.currentSession.callState+" call signal payload "+content.payload);
                this.handleSignalMsg(content.payload);
              }
            } else if(content instanceof CallByeMessageContent){
                if(!this.currentSession || this.currentSession.callState === CallState.STATUS_IDLE || protoMessage.from != this.currentSession.clientId || content.callId != this.currentSession.callId){
                  return;
                }
                this.cancelCall();
            }
          }
        }
    }


    async handleSignalMsg(payload){
      var signalMessage = JSON.parse(payload);
      var type = signalMessage.type;
      console.log('message type '+type);
      //新的用户来临
      if(type === "newParticipantArrived"){
          var name = signalMessage.name;
          console.log("new participant name "+name)
          this.onNewParticipant(name)
      } else if(type == "existingParticipants"){
          var existingParticipants = signalMessage.data;
          console.log("existingParticipants "+signalMessage.data)
          this.onExistingParticipants(signalMessage)
      } else if(type == "participantLeft"){
          var participantLeft = signalMessage.name;
          console.log("participantLeft "+participantLeft)
          onParticipantLeft(participantLeft)
      } else if(type == 'iceCandidate'){
          this.participants[signalMessage.name].rtcPeer.addIceCandidate(signalMessage.candidate, function (error) {
                if (error) {
                console.error("Error adding candidate: " + error);
                return;
                }
          });
      } 
    }


    newSession(clientId, audioOnly, callId){
        var session = new CallSession(this);
        session.clientId = clientId;
        session.audioOnly = audioOnly;
        session.callId = callId;
        session.sessionCallback = this.currentSessionCallback;
        return session;
    }

    sendMessage(target,messageConent,tos = ''){
        this.store.dispatch('sendMessage', new SendMessage(target,messageConent,tos));
    }

    rejectOtherCall(callId,clientId){
        var byeMessage = new CallByeMessageContent();
        byeMessage.callId = callId;
        this.log('reject other callId '+callId +" clientId "+clientId);
        this.sendMessage(clientId,byeMessage);
    }


    onExistingParticipants(msg) {
      var constraints = {
        audio : this.currentSession.audioOnly,
        video : {
          mandatory : {
            maxWidth : 320,
            maxFrameRate : 15,
            minFrameRate : 15
          }
        }
      };
      var currentUserId = LocalStore.getUserId();
      var participant = new Participant(currentUserId);
      this.participants[currentUserId] = participant;
      var video = participant.getVideoElement();
    
      var options = {
            localVideo: video,
            mediaConstraints: constraints,
            onicecandidate: participant.onIceCandidate.bind(participant)
          }
      participant.rtcPeer = new kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options,
        (error) => {
          if(error) {
            if(this.currentSessionCallback){
                this.currentSessionCallback.didError(error)
            }
            return console.error(error)
          }
          participant.rtcPeer.generateOffer (participant.offerToReceiveVideo.bind(participant));
      });
      
      for(var sender of msg.data){
          this.receiveVideo(sender)
      }
    }

    receiveVideo(sender) {
      var participant = new Participant(sender);
      participants[sender] = participant;
      var video = participant.getVideoElement(sender);
    
      var options = {
          remoteVideo: video,
          onicecandidate: participant.onIceCandidate.bind(participant)
        }
    
      participant.rtcPeer = new kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options,
          (error) => {
            if(error) {
              return console.error(error);
            }
            participant.rtcPeer.generateOffer (participant.offerToReceiveVideo.bind(participant));
      });;
    }

    onNewParticipant(name){
        this.receiveVideo(name)
    }

    onParticipantLeft(name) {
      console.log('Participant ' + name + ' left');
      var participant = this.participants[name];
      participant.dispose();
      delete this.participants[name];
    }
}